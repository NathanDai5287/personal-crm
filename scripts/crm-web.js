// crm-web.js — a tiny, dependency-free local web app for browsing the CRM
// profiles. Reads data/contacts/*.md LIVE on every request (so whatever the
// daily pipeline last wrote is what you see), renders the Markdown to HTML,
// and gates everything behind HTTP basic auth.
//
//   node scripts/crm-web.js            # http://localhost:8787
//   CRM_WEB_PORT=9000 node scripts/crm-web.js
//
// Auth: username = WEB_USER (default "nathan"). Password comes from
// env CRM_WEB_PASSWORD, else data/web-password.txt; if neither exists a random
// one is generated, saved to that file, and printed here once. Local-only by
// design — later this can be put behind a tunnel to reach crm.cal.taxi.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const {
  ROOT, CONTACTS_DIR, WEB_PORT, WEB_USER, WEB_PASSWORD_FILE,
  TRACKED, LOGS_DIR, GITDIR, MERGE_MODEL, TIMELINE_MODEL,
  BOT_SERVICE_ID,
} = require('../lib/config');
const { openCrmDb, openSignalDb } = require('../lib/signal-db');
const { estIngestFromRows, isFree, fmtUsd } = require('../lib/cost');
const { dateKey: ptDateKey, fmtLocal: ptLocal, weekStart, nextWeekStart, nextPacificDaily } = require('../lib/weeks');
const { resolveSources, buildMessageQuery, buildArchiveQuery } = require('../lib/sources');
const { validateCitations, ensureMessagesTable } = require('../lib/archive');
const { renderedBody } = require('../lib/message-context');
const { decryptByHash } = require('../lib/signal-attachments');
const TASKS = require('../lib/tasks');
const P = require('../lib/nicknames');
const PERSON = require('../lib/person');
const { factLabel } = require('../lib/structured-person');
const { recordFact, retractCurrentFact, mentionEdges, edgeCitations, recordReassign } = require('../lib/schema');
const RUN_TOGGLES = require('../lib/run-toggles');
const RUN_MODELS = require('../lib/run-models');
const JOBS_DEF = require('../lib/jobs'); // single source of truth for the job set + labels
const { STYLE: BINDERY_CSS, FONTS, FONTS_DIR, THEME_INIT, THEME_JS } = require('../lib/view/shell');
const { render, raw } = require('../lib/view/h');
const V = require('../lib/view/pages');
const { renderProfile, inline: mdInline, staleCount, sentLabel } = require('../lib/view/markdown');
const { parseDeadline } = require('../lib/deadline');
const ARCHIVE_STATE_FILE = path.posix.join(path.posix.dirname(TRACKED), 'crm-archive-state.json');

const RUNS_DIR = path.join(LOGS_DIR, 'runs');
const DAY = 86_400_000;
const BACKFILL_DAYS = 30; // mirror of crm-refresh.js's new-contact window

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function resolvePassword() {
  if (process.env.CRM_WEB_PASSWORD) return process.env.CRM_WEB_PASSWORD;
  try {
    const p = fs.readFileSync(WEB_PASSWORD_FILE, 'utf8').trim();
    if (p) return p;
  } catch { /* not created yet */ }
  const generated = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(WEB_PASSWORD_FILE, generated + '\n', { mode: 0o600 });
  // Don't echo the secret to the journal — it's already persisted 0600 in the
  // file. Print only where to read it, so `journalctl` can't leak the password.
  console.log(`\n  No password set — generated one and saved it (0600) to:\n    ${WEB_PASSWORD_FILE}\n  Username: ${WEB_USER}\n  (read the file for the password)\n`);
  return generated;
}

// Constant-time-ish credential check.
function authOk(header, user, pass) {
  if (!header || !header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i === -1) return false;
  const gotUser = decoded.slice(0, i);
  const gotPass = decoded.slice(i + 1);
  const a = Buffer.from(gotUser + '\0' + gotPass);
  const b = Buffer.from(user + '\0' + pass);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Per-client auth backoff (P5-4). Basic auth has no lockout of its own, so without
// this a tunnelled endpoint would accept unlimited password guesses. Keyed by the
// client — X-Forwarded-For's first hop when fronted by a tunnel, else the socket
// address. A few misses are free (fat-finger); after that, an exponential lockout
// capped at 15 min. A success clears the record. In-memory (resets on restart),
// which is the right lifetime for a brute-force speed bump.
const AUTH_FAILS = new Map(); // key -> { n, until }
const AUTH_FREE_TRIES = 3;
const AUTH_MAX_LOCK_MS = 15 * 60 * 1000;
function authKey(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function authBlockedMs(key) {
  const rec = AUTH_FAILS.get(key);
  return rec && rec.until > Date.now() ? rec.until - Date.now() : 0;
}
function authNoteFailure(key) {
  const rec = AUTH_FAILS.get(key) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n > AUTH_FREE_TRIES) rec.until = Date.now() + Math.min(1000 * 2 ** (rec.n - AUTH_FREE_TRIES), AUTH_MAX_LOCK_MS);
  if (AUTH_FAILS.size > 5000) AUTH_FAILS.clear(); // bound the map against forged-key floods
  AUTH_FAILS.set(key, rec);
}
function authClear(key) { AUTH_FAILS.delete(key); }

// ---------------------------------------------------------------------------
// Markdown rendering (compact, tuned for the profile format)
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Inline: **bold**, _italic_, `code`, [text](url), bare URLs, ⟨m…⟩ citations.
function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  // bare URLs not already inside an href
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  // _italic_ (avoid mangling inside words/URLs by requiring boundaries)
  out = out.replace(/(^|[\s(>])_([^_]+)_(?=$|[\s.,;:!?)<])/g, (_, pre, c) => `${pre}<em>${c}</em>`);
  // Provenance citations → superscript links.
  //
  // ONE LINK PER CITATION, not per id. A citation is now a thread-scoped RANGE
  // (docs/PROVENANCE-SPEC.md §1) — `⟨m90211-m90219 @m90215⟩` is a single source,
  // the stretch, and `/m/<start>-<end>` renders it; `#m<primary>` tells that page
  // which line to highlight. A degenerate `⟨m88104⟩` keeps its `/m/<id>` link, so
  // Timeline lines and single-message citations render exactly as before.
  //
  // Adjacent brackets are coalesced into ONE <sup>, and the counter runs across
  // the whole line so a bullet with citations in two places still numbers
  // 1,2,3,4 rather than 1,2 then 1,2. Trailing whitespace is deliberately not
  // consumed, so the space before following prose survives.
  //
  // Old comma-list citations (`⟨m1, m2⟩`) no longer match and fall through as
  // plain text — accepted: the archive is cleared and every profile rewritten
  // before this grammar goes live.
  const GROUP = String.raw`⟨\s*m\d+(?:-m\d+)?(?:\s+@m\d+)?(?:\s+ts)?\s*⟩`;
  const ONE = /⟨\s*m(\d+)(?:-m(\d+))?(?:\s+@m(\d+))?(?:\s+ts)?\s*⟩/g;
  let n = 0;
  out = out.replace(new RegExp(`${GROUP}(?:\\s*${GROUP})*`, 'g'), (run) => {
    const seen = new Set();
    const links = [];
    for (const m of run.matchAll(ONE)) {
      const start = m[1];
      const end = m[2] || start;
      const primary = m[3] || null;
      // The same stretch cited twice in one run would otherwise render as two
      // differently-numbered links to the same span.
      const key = `${start}-${end}${primary ? `@${primary}` : ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      n += 1;
      const href = (end === start ? `/m/${start}` : `/m/${start}-${end}`) + (primary ? `#m${primary}` : '');
      const label = end === start ? `m${start}` : `m${start}–m${end}`;
      links.push(`<a href="${href}" target="_blank" rel="noopener" title="source ${label}${primary ? `, key line m${primary}` : ''}">${n}</a>`);
    }
    return links.length ? `<sup class="cites">${links.join('')}</sup>` : run;
  });
  return out;
}

// Pull a few metadata fields from the leading "- **Key:** value" bullets.
function parseMeta(md) {
  const meta = {};
  const re = /^-\s+\*\*([^:*]+):\*\*\s*(.+)$/;
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith('## ')) break; // metadata block is only at the top
    const m = line.trim().match(re);
    if (m) meta[m[1].trim().toLowerCase()] = m[2].replace(/[_*]/g, '').trim();
  }
  return meta;
}

// Pull the `## Talking points` bullets: [{date|null, text}].
// MONTH PRECISION IS LEGAL. prompts/merge.md permits `YYYY-MM` when only the
// month is known ("sometime in August") rather than stamping a false precise day —
// and real profiles use it (nigesh carries `2027-02`). Requiring YYYY-MM-DD
// here silently demoted those to undated and left the `**…**` markup in the text.
// The bold is optional: bullets written before 2026-08-11 carry `**date**`, newer
// ones a plain date (prompt v12 keeps bold for structure labels only).
//
// `line` is the 1-based file line, needed to blame the bullet back to the merge
// that wrote it.
function parseTalkingPoints(md) {
  const items = [];
  let inSection = false;
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^##\s+Talking points/i.test(t)) { inSection = true; continue; }
    if (inSection && /^#/.test(t)) break; // next heading ends the section
    if (!inSection) continue;
    const m = t.match(/^[-*]\s+(?:(?:\*\*)?(\d{4}-\d{2}(?:-\d{2})?)(?:\*\*)?\s+)?(.+)$/);
    if (m && m[2]) {
      items.push({
        date: m[1] || null,
        // A month-only date sorts and compares correctly against YYYY-MM-DD once
        // padded; keep the raw form for display.
        sortDate: m[1] ? (m[1].length === 7 ? `${m[1]}-01` : m[1]) : null,
        text: m[2].trim(),
        line: i + 1,
      });
    }
  }
  return items;
}

// Section-scoped bullet reader, for `## Open questions` (uncited by design) and
// anything else worth surfacing as a task.
function parseSectionBullets(md, heading) {
  const items = [];
  let inSection = false;
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (new RegExp(`^##\\s+${heading}`, 'i').test(t)) { inSection = true; continue; }
    if (inSection && /^#/.test(t)) break;
    if (!inSection) continue;
    const m = t.match(/^[-*]\s+(.+)$/);
    if (m) items.push({ text: m[1].trim(), line: i + 1 });
  }
  return items;
}

// git blame -> { lineNumber: { sha, model, prompt, subject } }.
//
// This is the provenance the profile format cannot carry: which merge wrote a
// given line, under which model and prompt. --porcelain because it is the only
// stable machine format; -w so a reflow does not reattribute a line.
const BLAME_CACHE = new Map();
function blameProfile(slug) {
  // Keyed on mtime, not just slug: this server outlives merges, and a cache keyed
  // on slug alone would serve pre-merge provenance forever.
  let mtime = 0;
  try { mtime = fs.statSync(path.posix.join(CONTACTS_DIR, `${slug}.md`)).mtimeMs; } catch { /* gone */ }
  const key = `${slug}@${mtime}`;
  if (BLAME_CACHE.has(key)) return BLAME_CACHE.get(key);
  const map = new Map();
  try {
    const out = execFileSync('git', [
      '--git-dir', GITDIR, '--work-tree', ROOT, 'blame', '--porcelain', '-w',
      '--', `data/contacts/${slug}.md`,
    ], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    const meta = new Map();          // sha -> { subject, model, prompt }
    let sha = null, resultLine = null;
    for (const line of out.split('\n')) {
      const hdr = /^([0-9a-f]{40})\s+\d+\s+(\d+)/.exec(line);
      if (hdr) { sha = hdr[1]; resultLine = Number(hdr[2]); continue; }
      if (!sha) continue;
      if (line.startsWith('summary ')) {
        const s = line.slice(8);
        const rec = meta.get(sha) || {};
        // Trailers can be folded into the subject on older commits.
        rec.subject = s.split(/\s+Model:\s/)[0].trim();
        const mm = /\bModel:\s*(\S+)/.exec(s); if (mm) rec.model = mm[1];
        const pm = /\bPrompt:\s*(\S+)/.exec(s); if (pm) rec.prompt = pm[1];
        meta.set(sha, rec);
      }
      if (line.startsWith('\t') && resultLine != null) {
        map.set(resultLine, { sha, ...(meta.get(sha) || {}) });
        resultLine = null;
      }
    }
    // --porcelain's `summary` is only the SUBJECT line, so a correctly formatted
    // commit keeps its trailers in the body where blame never shows them. Fetch
    // the body once per unique sha to fill those in.
    for (const [sha2, rec] of meta) {
      if (rec.model) continue;
      try {
        const body = execFileSync('git', ['--git-dir', GITDIR, 'log', '-1', '--format=%B', sha2],
          { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
        const mm = /^Model:\s*(\S+)/m.exec(body); if (mm) rec.model = mm[1];
        const pm = /^Prompt:\s*(\S+)/m.exec(body); if (pm) rec.prompt = pm[1];
      } catch { /* leave unknown */ }
    }
    // Re-apply: map entries were built with a SPREAD of meta during parsing, so
    // they are snapshots taken before the fill above and would silently keep the
    // pre-fill values.
    for (const [ln, rec] of map) map.set(ln, { ...rec, ...(meta.get(rec.sha) || {}) });
  } catch { /* uncommitted or untracked: no provenance available */ }
  BLAME_CACHE.set(key, map);
  return map;
}

function listContacts() {
  let files = [];
  try { files = fs.readdirSync(CONTACTS_DIR).filter((f) => f.endsWith('.md')); } catch { /* none */ }
  const contacts = [];
  for (const f of files) {
    const slug = f.replace(/\.md$/, '');
    let md;
    try { md = fs.readFileSync(path.posix.join(CONTACTS_DIR, f), 'utf8'); } catch { continue; }
    const meta = parseMeta(md);
    const titleLine = md.split(/\r?\n/).find((l) => l.startsWith('# '));
    const name = titleLine ? titleLine.slice(2).trim() : slug;
    contacts.push({
      slug,
      name,
      relationship: meta['relationship'] || '',
      last: meta['last contact'] || '',
      messages: meta['messages'] || '',
      talkingPoints: parseTalkingPoints(md),
    });
  }
  // Sort by last-contact date desc (ISO-ish strings sort lexically); blanks last.
  contacts.sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  return contacts;
}

// ---------------------------------------------------------------------------
// HTML shell
// ---------------------------------------------------------------------------
// Legacy classes still used by detail views not yet on the Bindery components
// (run detail, diffs, the tasks header). Written against Bindery's theme
// variables so they adapt to light/dark; shrinks as pages move over.
const LEGACY_CSS = `
.sub{color:var(--soft);font-size:13px}
table.tbl{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--rule);font-size:13px}
table.tbl th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);text-align:left}
table.tbl th,table.tbl td{padding:8px 12px;border-bottom:1px solid var(--rule)}
table.tbl tr:last-child td{border-bottom:0}
table.tbl td.num{font-variant-numeric:tabular-nums;text-align:right}
.ok{color:#2e9e5b}.bad{color:var(--ox)}.skip{color:var(--faint)}
.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:8px;background:var(--card2);color:var(--soft)}
.badge.hot{background:var(--stamp);color:#fff;font-weight:600}
pre.log{background:var(--paper);border:1px solid var(--rule);padding:12px 14px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;color:var(--ink)}
pre.diff{background:var(--paper);border:1px solid var(--rule);padding:12px 14px;font-size:12px;overflow-x:auto;color:var(--ink)}
pre.diff .add{color:#2e9e5b}pre.diff .del{color:var(--ox)}pre.diff .hunk{color:var(--stamp)}pre.diff .ctx{color:var(--soft)}
.difflabel{font-family:"Courier Prime",monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--soft);margin:14px 0 4px}
details.step{background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:8px 12px;margin:6px 0}
details.step summary{cursor:pointer;display:flex;gap:10px;align-items:baseline}
details.step summary .nm{font-weight:600}
details.step summary .ms{color:var(--soft);font-size:12px;margin-left:auto}
`;

// Bindery shell. Bindery pages pass a body that already includes the nav tabs;
// legacy pages pass `current` and get the tabs prepended.
function page(title, bodyHtml, current) {
  const nav = current ? render(V.Tabs(current)) : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${esc(title)}</title>${THEME_INIT}${FONTS}<style>${BINDERY_CSS}${LEGACY_CSS}</style></head>`
    + '<body><button class="lamp" onclick="__lamp()">☾ dark</button>'
    + `<div class="sheet">${nav}${bodyHtml}</div>${THEME_JS}</body></html>`;
}

// ---- tasks -----------------------------------------------------------------
// Every actionable item across every contact, with where it came from.
//
// TWO LAYERS OF PROVENANCE, because they answer different questions:
//   ⟨m…⟩ citations  -> WHAT was said. Links to the message itself.
//   git blame       -> WHO WROTE THE LINE: which merge, model, prompt, ledger.
// The second matters because a task is a model's *interpretation* of a message,
// and "kimi-k3 inferred this on 2026-08-03 from chunk 4/6" is a different claim
// from "Nigesh said this".
//
// Deliberately NOT sourced from the `reminders` table: it exists in crm.db but has
// zero rows and nothing writes to it. Reading it would imply it works.
function taskItems() {
  const today = ptDateKey(Date.now());
  const out = { upcoming: [], recent: [], undated: [], questions: [] };
  let files = [];
  try { files = fs.readdirSync(CONTACTS_DIR).filter((f) => f.endsWith('.md')); } catch { return out; }

  for (const f of files) {
    const slug = f.replace(/\.md$/, '');
    let md;
    try { md = fs.readFileSync(path.posix.join(CONTACTS_DIR, f), 'utf8'); } catch { continue; }
    const titleLine = md.split(/\r?\n/).find((l) => l.startsWith('# '));
    const name = titleLine ? titleLine.slice(2).trim() : slug;
    // No blame here. It was one `git blame` subprocess per contact on every page
    // load, and the model/chunk badges it fed are internal plumbing that meant
    // nothing to the reader. Line-level authorship still lives on the profile
    // history page, where it is actually a debugging question.
    for (const tp of parseTalkingPoints(md)) {
      const item = { ...tp, slug, name };
      if (!tp.sortDate) out.undated.push(item);
      else if (tp.sortDate >= today) out.upcoming.push(item);
      else out.recent.push(item);
    }
  }
  out.upcoming.sort((a, b) => a.sortDate.localeCompare(b.sortDate));
  out.recent.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
  out.all = [...out.upcoming, ...out.recent, ...out.undated];
  return out;
}

// Toggling a task done/reopen posts in the background — no full page reload. The
// X-Requested-With header tells the POST handler to answer 204 instead of the 303
// a form submit gets. The card physically moves between the Active and Done lists
// (done at the bottom, matching what a fresh render shows), the plate counts are
// nudged to match, and a failed request reverts the checkbox.
const TASKS_TOGGLE_JS = `<script>(function(){
  function adj(id,d){var el=document.getElementById(id);if(!el)return;var n=parseInt(el.textContent,10)||0;el.textContent=Math.max(0,n+d);}
  function reflow(){
    var act=document.getElementById('activeList'),wrap=document.getElementById('doneWrap'),dn=document.getElementById('doneList'),none=document.getElementById('noActive');
    if(wrap&&dn)wrap.style.display=dn.querySelector('.taskcard')?'':'none';
    if(none&&act)none.style.display=act.querySelector('.taskcard')?'none':'';
  }
  document.querySelectorAll('.taskbox').forEach(function(box){
    box.addEventListener('change',function(){
      var id=box.getAttribute('data-id'),nowDone=box.checked,card=box.closest('.taskcard');
      box.disabled=true;
      fetch('/tasks/'+(nowDone?'done':'reopen'),{
        method:'POST',
        headers:{'X-Requested-With':'fetch','Content-Type':'application/x-www-form-urlencoded'},
        body:'id='+encodeURIComponent(id)
      }).then(function(r){
        if(!r.ok)throw new Error(r.status);
        if(card){
          card.classList.toggle('done',nowDone);
          var dest=document.getElementById(nowDone?'doneList':'activeList');
          if(dest){if(nowDone)dest.appendChild(card);else dest.insertBefore(card,dest.firstChild);}
          reflow();
        }
        adj('cActive',nowDone?-1:1);adj('cDone',nowDone?1:-1);
      }).catch(function(){box.checked=!nowDone;}).then(function(){box.disabled=false;});
    });
  });
})();</script>`;

// Translate a typed due date ("eod", "monday", "aug 15") into an ISO date when
// the field loses focus, by asking the server (one parser, lib/deadline.js). The
// submit handler re-parses server-side, so this is just live feedback.
const TASKS_DATE_JS = `<script>(function(){
  document.querySelectorAll('input[name=deadline]').forEach(function(inp){
    inp.addEventListener('change',function(){
      var v=inp.value.trim();
      if(!v)return;
      fetch('/tasks/parse-date?q='+encodeURIComponent(v)).then(function(r){return r.json();}).then(function(d){
        if(d&&d.date)inp.value=d.date;
      }).catch(function(){});
    });
  });
})();</script>`;

// The profile page's inline editing, ported to task cards: clicking a value (or
// its hover pencil) swaps in a seamless editor; Enter/Escape/blur closes it with
// the change kept, staged locally; the shared bottom bar saves every dirty card
// (one POST /tasks/edit each) and reloads so the server re-sorts and re-renders
// citation slips. The importance stamp cycles minor → norm → high on click and
// stages the same way. Unlike the profile there is no "for the record" line —
// task rows carry no provenance log for a message to land in.
const TASKS_EDIT_JS = `<script>(function(){
  var bar=document.getElementById('editbar'),barN=document.getElementById('editbarN');
  if(!bar)return;
  var flds=[].slice.call(document.querySelectorAll('.taskcard .efield'));
  var imps=[].slice.call(document.querySelectorAll('.taskcard .impbtn'));
  var IMPW={1:'minor',2:'norm',3:'high'},IMPNEXT={1:2,2:3,3:1};
  function inp(f){return f.querySelector('.efield-input');}
  function norm(v){return v.replace(/\\r/g,'').trim();}
  function fldDirty(f){return norm(inp(f).value)!==norm(inp(f).defaultValue);}
  function impDirty(m){return m.dataset.val!==m.dataset.orig;}
  function refresh(){
    var n=0;
    flds.forEach(function(f){var d=fldDirty(f);f.classList.toggle('dirty',d);if(d)n++;});
    imps.forEach(function(m){var d=impDirty(m);m.classList.toggle('dirty',d);if(d)n++;});
    bar.hidden=n===0;
    if(n)barN.textContent=n+' unsaved change'+(n===1?'':'s');
  }
  function size(ta){if(ta.tagName==='TEXTAREA'){ta.style.height='auto';ta.style.height=(ta.scrollHeight+2)+'px';}}
  function display(f){
    var i=inp(f),val=f.querySelector('.efield-val'),v=norm(i.value);
    if(v===norm(i.defaultValue))val.innerHTML=f.dataset.orig;
    else if(v)val.textContent=v;
    else val.innerHTML=f.dataset.empty;
  }
  function close(f){
    var i=inp(f);
    if(f.dataset.f==='title'&&!norm(i.value))i.value=i.defaultValue; // a task keeps its title
    f.classList.remove('editing');i.hidden=true;f.querySelector('.efield-val').hidden=false;
    // typed due words become the date the server will store ("monday" -> 2026-08-17)
    if(f.dataset.f==='deadline'){
      var v=norm(i.value);
      if(v&&!/^\\d{4}-\\d{2}-\\d{2}$/.test(v)){
        fetch('/tasks/parse-date?q='+encodeURIComponent(v)).then(function(r){return r.json();}).then(function(d){
          if(d&&d.date){i.value=d.date;display(f);refresh();}
        }).catch(function(){});
      }
    }
    display(f);refresh();
  }
  flds.forEach(function(f){
    var i=inp(f),val=f.querySelector('.efield-val');
    f.dataset.orig=val.innerHTML;
    f.dataset.empty=f.dataset.f==='deadline'?'<em class="tnone">\\u2014</em>':'<em class="tnone">add a note</em>';
    var open=function(){f.classList.add('editing');val.hidden=true;i.hidden=false;size(i);i.focus();};
    f.querySelector('.ebtn').addEventListener('click',open);
    val.addEventListener('click',function(e){if(e.target.closest('a'))return;open();});
    i.addEventListener('input',function(){size(i);refresh();});
    i.addEventListener('blur',function(){close(f);});
    i.addEventListener('keydown',function(e){
      if(e.key==='Escape'||(e.key==='Enter'&&i.tagName!=='TEXTAREA')){e.stopPropagation();close(f);}
    });
  });
  imps.forEach(function(m){
    m.dataset.orig=m.dataset.val;
    m.addEventListener('click',function(){
      var v=IMPNEXT[Number(m.dataset.val)]||2;
      m.dataset.val=v;m.textContent=IMPW[v];
      m.className='impmark impbtn '+IMPW[v];
      refresh();
    });
  });
  document.getElementById('btnCancel').addEventListener('click',function(){
    if(!confirm('Discard all unsaved changes?'))return;
    flds.forEach(function(f){inp(f).value=inp(f).defaultValue;close(f);});
    imps.forEach(function(m){var v=Number(m.dataset.orig);m.dataset.val=v;m.textContent=IMPW[v];m.className='impmark impbtn '+IMPW[v];});
    refresh();
  });
  document.getElementById('btnSave').addEventListener('click',function(){
    var cards=[].slice.call(document.querySelectorAll('.taskcard')).filter(function(c){
      return c.querySelector('.efield.dirty,.impbtn.dirty');
    });
    if(!cards.length)return;
    var btn=this;btn.disabled=true;
    Promise.all(cards.map(function(c){
      var g=function(k){var f=c.querySelector('.efield[data-f='+k+'] .efield-input');return f?norm(f.value):'';};
      var im=c.querySelector('.impbtn');
      var body='id='+encodeURIComponent(c.dataset.id)
        +'&title='+encodeURIComponent(g('title'))
        +'&description='+encodeURIComponent(g('description'))
        +'&deadline='+encodeURIComponent(g('deadline'))
        +'&importance='+encodeURIComponent(im?im.dataset.val:2);
      return fetch('/tasks/edit',{method:'POST',
        headers:{'X-Requested-With':'fetch','Content-Type':'application/x-www-form-urlencoded'},
        body:body}).then(function(r){if(!r.ok)throw new Error(r.status);});
    })).then(function(){location.reload();})
      .catch(function(){btn.disabled=false;barN.textContent='save failed \\u2014 changes still unsaved';});
  });
})();</script>`;

function tasksPage() {
  let cdb;
  try { cdb = openCrmDb(); } catch { return page('To do — personal-crm', '<p class="bad">archive unavailable</p>', '/tasks'); }
  let drafts = [];
  let active = [];
  let done = [];
  let counts = { draft: 0, active: 0, done: 0, dismissed: 0 };
  try {
    // Drafts are ROWS, written by scripts/crm-tasks.js during an ingest run — not
    // derived from the profile. Deriving them from `## Talking points` is what
    // filled this list with conversation topics instead of commitments.
    drafts = TASKS.listByStatus(cdb, 'draft');
    active = TASKS.listByStatus(cdb, 'active');
    done = TASKS.listByStatus(cdb, 'done');
    counts = TASKS.counts(cdb);
  } finally {
    try { cdb.close(); } catch { /* closed */ }
  }
  // Shape the DB rows into what lib/view's tasks page expects: a display name, the
  // source-message id, and description Markdown pre-rendered to Bindery HTML so its
  // ⟨m…⟩ citations become slips. One date resolver serves the page: the slip's
  // face is the trigger's send date ("agreed last week"), exact date on hover.
  const dates = msgDates();
  try {
    const now = Date.now();
    const mdOpts = { dateFor: dates.dateFor, now };
    const shape = (t) => {
      const ms = t.source_msg_id ? dates.dateFor(t.source_msg_id) : null;
      return {
        ...t,
        name: t.contact_name || t.slug,
        msgId: t.source_msg_id,
        rangeStart: t.range_start,
        rangeEnd: t.range_end,
        sentD: ms ? sentLabel(ms, now) : null,
        sentKey: ms ? ptDateKey(ms) : null,
        probable: t.confidence === 'probable',
        descHtml: t.description ? mdInline(t.description, mdOpts) : '',
      };
    };
    const data = {
      counts, today: ptDateKey(now),
      active: active.map(shape), done: done.map(shape), drafts: drafts.map(shape),
    };
    return page('To do — personal-crm', render(V.tasks(data).body) + TASKS_TOGGLE_JS + TASKS_DATE_JS + TASKS_EDIT_JS);
  } finally {
    dates.close();
  }
}


// Real contacts mapped to the shape lib/view's people/admin pages expect. Facts
// are the top talking points, rendered to HTML so their ⟨m…⟩ slips survive.
// `waiting` is archived-but-not-yet-merged: the contact's own messages not in the
// `merged` ledger. (Board approximation — counts their contact_slug rows, not the
// full-group context the merge also reads; exact reachability lives in the planner.)
function contactList() {
  const cdb = openCrmDb();
  try {
    ensureMessagesTable(cdb); // make sure the `merged` ledger table exists to join
    // Held count + live last-contact per contact, bot-excluded (Janet's messages
    // in a me+contact+bot group don't count as the contact's traffic). `src IS
    // NOT ?` is NULL-safe, so non-bot rows with a null src still count.
    const held = new Map();
    const lastSeen = new Map();
    for (const r of cdb.prepare("SELECT contact_slug slug, COUNT(*) n, MAX(sent_at) mx FROM messages WHERE contact_slug IS NOT NULL AND src IS NOT ? GROUP BY contact_slug").all(BOT_SERVICE_ID)) {
      held.set(r.slug, r.n);
      if (r.mx) lastSeen.set(r.slug, r.mx);
    }
    const pending = cdb.prepare('SELECT COUNT(*) n FROM messages WHERE contact_slug = ? AND id NOT IN (SELECT message_id FROM merged WHERE slug = ?)');
    // heldReview: this contact's ingest is paused because a merge chunk was rejected by
    // the model provider's content filter and is waiting for Nathan to pick a masking
    // rule (lib/censor-hold.js). Surfaced in the UI so a stuck person is visible.
    const HOLD = require('../lib/censor-hold');
    return listContacts().map((c) => {
      const waiting = pending.get(c.slug, c.slug).n;
      const person = PERSON.getPerson(c.slug, { cdb });
      const structuredFacts = person
        ? person.facts.filter((f) => !['relationship', 'birthday', 'phone', 'signal_id'].includes(f.field)).slice(0, 3)
        : [];
      const structured = structuredFacts.length
        ? structuredFacts.map((f) => mdInline(`**${factLabel(f.field)}:** ${f.value}${f.src_msg ? ` ⟨m${f.src_msg}⟩` : ''}`))
        : null;
      const facts = structured || c.talkingPoints.slice(0, 3).map((tp) => mdInline((tp.date ? `**${tp.date}** ` : '') + tp.text));
      return {
        slug: c.slug, name: person ? person.name : c.name, rel: person ? person.relationship : c.relationship,
        last: lastSeen.has(c.slug) ? ptDateKey(lastSeen.get(c.slug)) : (person ? person.lastContact : c.last),
        held: held.get(c.slug) || 0, waiting, facts, heldReview: HOLD.isHeld(c.slug),
        stamp: waiting > 0 ? `${waiting} waiting` : null, stampBlue: true,
      };
    });
  } finally {
    cdb.close();
  }
}

// Suggestions + the contact picker for the People-tab nickname inbox. `list` is a
// contactList() result, reused so we don't re-query. Cite slips resolve like a
// profile's. Suggestions come from lib/nicknames (assigned + unassigned).
function inboxData(list) {
  const nameBySlug = new Map(list.map((c) => [c.slug, c.name]));
  // Nathan (the owner) is a valid assign target too — a suggestion like "wayne" is his.
  // He's not a tracked contact, so add him explicitly at the top of the picker (P1 #5).
  const contacts = [{ slug: OWNER_SLUG, name: 'Nathan (me)' },
    ...list.map((c) => ({ slug: c.slug, name: c.name })).sort((a, b) => a.name.localeCompare(b.name))];
  const dates = msgDates();
  try {
    const now = Date.now();
    const suggestions = P.listSuggestions().map((s) => ({
      id: s.id, text: s.text, slug: s.slug,
      name: s.slug ? (nameBySlug.get(s.slug) || s.slug) : null,
      cites: nickCites(s.cites, dates, now),
    }));
    return { suggestions, contacts };
  } finally {
    dates.close();
  }
}

function renderInbox() {
  const list = contactList();
  const { suggestions, contacts } = inboxData(list);
  return render(V.NnInbox(suggestions, contacts));
}

// One inbox action by nickname id. assign (to a contact — also confirms), confirm
// (an already-assigned suggestion), or dismiss (delete + denylist).
function applyNickInbox(action, payload) {
  const id = Number(payload.id);
  if (!Number.isInteger(id)) return { ok: false, status: 400, error: 'bad id' };
  if (action === 'confirm') return P.confirmById(id) ? { ok: true } : { ok: false, status: 409, error: 'assign it to a contact first, or it no longer exists' };
  if (action === 'dismiss') return P.dismissById(id) ? { ok: true } : { ok: false, status: 404, error: 'that suggestion no longer exists — reload' };
  if (action === 'assign') {
    const slug = String(payload.slug || '').trim();
    if (!isSafeSlug(slug)) return { ok: false, status: 400, error: 'bad contact' };
    // The owner has no contact file; every other slug must be a real contact.
    if (slug !== OWNER_SLUG) {
      try { fs.readFileSync(path.posix.join(CONTACTS_DIR, `${slug}.md`), 'utf8'); } catch { return { ok: false, status: 404, error: 'no such contact' }; }
    }
    return P.assignNickname(id, slug) ? { ok: true } : { ok: false, status: 404, error: 'that suggestion no longer exists — reload' };
  }
  return { ok: false, status: 400, error: 'unknown action' };
}

// Client for the People-tab inbox: delegate clicks on #nnInbox controls, POST the
// action by id, and swap the whole block for the server's re-render.
const NN_INBOX_JS = `<script>(function(){
  function post(action,payload){
    return fetch('/nick/'+action,{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},
      body:JSON.stringify(payload||{})}).then(function(r){return r.json().catch(function(){return{ok:false};});});
  }
  document.addEventListener('click',function(e){
    if(!e.target.closest)return;
    var btn=e.target.closest('#nnInbox [data-act]'); if(!btn)return;
    var li=btn.closest('.nn-inbox-item'); if(!li)return;
    var id=Number(li.getAttribute('data-nn-id')); var act=btn.getAttribute('data-act');
    var payload={id:id};
    if(act==='assign'){var sel=li.querySelector('.nn-assign-sel');var slug=sel&&sel.value;if(!slug){if(sel)sel.focus();return;}payload.slug=slug;}
    btn.disabled=true;
    post(act,payload).then(function(r){
      if(r&&r.ok&&r.html!=null){var cur=document.getElementById('nnInbox');if(cur)cur.outerHTML=r.html;}
      else{btn.disabled=false;}
    });
  });
})();</script>`;

function indexPage() {
  const list = contactList();
  const { suggestions, contacts } = inboxData(list);
  return page('People — personal-crm', render(V.people(list, { suggestions, contacts }).body) + NN_INBOX_JS);
}

// A nickname's citation slips resolve exactly like a fact bullet's: the face is the
// message's send date relative-to-now (sentLabel), the exact Pacific date rides
// in the hover title (sd), and no archived date falls back to a dagger. Shared by
// profilePage and the /c/<slug>/nick/* endpoints so both render the same slips.
// `dates` is a msgDates() resolver; `now` its reference clock.
function nickCites(cites, dates, now) {
  return (cites || []).map((id) => {
    const ms = dates.dateFor(id);
    return ms ? { a: id, d: sentLabel(ms, now), sd: ptDateKey(ms) } : { a: id };
  });
}

// Nathan is not a tracked contact (no profile is written ABOUT him), but people
// address him by nicknames and the /me page lets him keep them. His nickname rows
// live under this slug in the same store; the routes below special-case it so it
// doesn't need a data/contacts/<slug>.md file.
const OWNER_SLUG = 'nathan';

// Render a contact's nicknames to the `.nn` block HTML the profile shows and the
// endpoints swap in. One msgDates() resolver per call; closed before returning.
function renderNicks(slug) {
  const dates = msgDates();
  try {
    const now = Date.now();
    const nicks = P.listNicknames(slug).map((n) => ({ ...n, cites: nickCites(n.cites, dates, now) }));
    return render(V.Nicks(nicks));
  } finally {
    dates.close();
  }
}

// The server-enforced nickname length cap. The client also sets maxLength=40 on its
// inputs, but that is only a hint; this is the real limit for add and edit.
const NICKNAME_MAX = 40;

// Apply one nickname mutation from the profile's NN_JS, keyed by `action`. Validates
// the contact exists (like profilePage) and the payload, then delegates to
// lib/nicknames.js. Every mutation is slug-scoped in the store, so an id belonging to
// another contact no-ops and is reported as a 404. Returns { ok:true } or
// { ok:false, status, error }; the caller re-renders the block.
function applyNickEdit(slug, action, payload) {
  // The owner (/me) has no contact file; every other slug must be a real contact.
  if (slug !== OWNER_SLUG) {
    const file = path.posix.join(CONTACTS_DIR, `${slug}.md`);
    try { fs.readFileSync(file, 'utf8'); } catch { return { ok: false, status: 404, error: 'no such contact' }; }
  }
  const nickId = () => {
    const id = Number(payload.id);
    return Number.isInteger(id) ? id : null;
  };
  const nickText = () => String(payload.text == null ? '' : payload.text).trim();
  const gone = { ok: false, status: 404, error: 'that nickname no longer exists — reload the page' };
  if (action === 'add') {
    const text = nickText();
    if (!text) return { ok: false, status: 400, error: 'a nickname is required' };
    if (text.length > NICKNAME_MAX) return { ok: false, status: 400, error: `nickname too long (${NICKNAME_MAX} characters max)` };
    P.addNickname(slug, text);
    return { ok: true };
  }
  if (action === 'confirm') {
    const id = nickId();
    if (id == null) return { ok: false, status: 400, error: 'bad id' };
    if (P.confirmNickname(slug, id) == null) return gone;
    return { ok: true };
  }
  if (action === 'edit') {
    const id = nickId();
    if (id == null) return { ok: false, status: 400, error: 'bad id' };
    const text = nickText();
    if (!text) return { ok: false, status: 400, error: 'a nickname is required' };
    if (text.length > NICKNAME_MAX) return { ok: false, status: 400, error: `nickname too long (${NICKNAME_MAX} characters max)` };
    if (P.editNickname(slug, id, text) == null) return gone;
    return { ok: true };
  }
  if (action === 'dismiss') {
    const id = nickId();
    if (id == null) return { ok: false, status: 400, error: 'bad id' };
    if (!P.dismissNickname(slug, id)) return gone;
    return { ok: true };
  }
  return { ok: false, status: 400, error: 'unknown action' };
}

// Shared bubble renderer for both provenance views. Every bubble carries
// `id="m<rowid>"` so a URL fragment can address one — `/m/<start>-<end>#m<primary>`
// highlights the primary client-side, since the fragment never reaches the server.
// `hitId` is the server-known highlight (the single message of /m/<id>).
// `dimIds` is the surrounding-context rows: rendered readable but faded, so the
// cited message(s) are what the eye lands on.
// Per-attachment "open the original" links (the Layer-1 escape hatch). Each hash
// resolves through /media/<hash>, which decrypts and serves the real file.
function mediaLinks(attHashes) {
  const hashes = String(attHashes || '').split(/\s+/).filter((h) => /^[0-9a-f]{16,}$/i.test(h));
  if (!hashes.length) return '';
  return `<span class="orig">` + hashes.map((h) =>
    `<a href="/media/${h}" target="_blank" rel="noopener" title="open the original attachment">↗ original</a>`).join(' ') + `</span>`;
}

function msgBubbles(cdb, rows, hitId, dimIds) {
  const fmt = ptLocal; // Pacific, matching every ledger/Timeline stamp

  return rows.map((m) => {
    const mine = /^nathan$/i.test(m.sender);
    const hit = m.id === hitId ? ' hit' : '';
    const dim = dimIds && dimIds.has(m.id) ? ' dim' : '';
    // Layer 2 (Rendered): the stored body + OCR/STT fold. UNCENSORED — the UI default;
    // the "↗ original" links reveal the raw file (Layer 1).
    return `<div class="q ${mine ? 'me' : 'them'}${hit}${dim}" id="m${m.id}">` +
      `<span class="who">${esc(m.sender)} · ${esc(fmt(m.sent_at))}</span>${mdInline(renderedBody(cdb, m))}${mediaLinks(m.att_hashes)}</div>`;
  }).join('');
}

// Scroll the highlighted bubble into view. A `#m<id>` fragment, if present and
// real, becomes the highlight; otherwise the server-marked `.hit` is used. With
// neither, land on the first non-dim bubble — a range citation with no primary
// would otherwise open at the top of its leading context.
const SCROLL_TO_HIT = `<script>(function(){`
  + `var h=(location.hash||'').slice(1),t=h&&/^m\\d+$/.test(h)?document.getElementById(h):null;`
  + `if(t)t.classList.add('hit');else t=document.querySelector('.q.hit')||document.querySelector('.q:not(.dim)');`
  + `if(t)t.scrollIntoView({block:'center'});})();</script>`;

// Provenance view: one archived message, highlighted, with the 20 messages
// before and 10 after from the same conversation dimmed around it — resolved
// from crm.db's archive (not Signal's DB), so cited messages stay viewable even
// if Signal purges history.
function messagePage(id) {
  let cdb;
  try { cdb = openCrmDb(); } catch { return null; }
  try {
    let msg = null;
    try { msg = cdb.prepare('SELECT * FROM messages WHERE id = ?').get(id); } catch { /* archive table not created yet */ }
    if (!msg) return null;
    const before = msg.conv_id
      ? cdb.prepare('SELECT * FROM messages WHERE conv_id = ? AND (sent_at < ? OR (sent_at = ? AND id < ?)) ORDER BY sent_at DESC, id DESC LIMIT 20')
          .all(msg.conv_id, msg.sent_at, msg.sent_at, msg.id).reverse()
      : [];
    const after = msg.conv_id
      ? cdb.prepare('SELECT * FROM messages WHERE conv_id = ? AND (sent_at > ? OR (sent_at = ? AND id > ?)) ORDER BY sent_at ASC, id ASC LIMIT 10')
          .all(msg.conv_id, msg.sent_at, msg.sent_at, msg.id)
      : [];
    const dim = new Set([...before, ...after].map((m) => m.id));
    const backHref = msg.contact_slug ? `/c/${encodeURIComponent(msg.contact_slug)}` : '/';
    const body = `<div class="back"><a href="${backHref}">&larr; back</a></div>` +
      `<div class="profile"><h1>${esc(msg.conversation || 'Conversation')}</h1>` +
      `<p class="sub">source message <code>m${msg.id}</code>, shown with surrounding context</p>` +
      `<div class="charge">${msgBubbles(cdb, [...before, msg, ...after], msg.id, dim)}</div></div>` +
      SCROLL_TO_HIT;
    return page(`m${msg.id} — ${msg.conversation || 'message'}`, body, '/');
  } finally {
    try { cdb.close(); } catch { /* already closed */ }
  }
}

// Provenance view for a RANGE citation: `/m/<start>-<end>`, optionally
// `#m<primary>`.
//
// THREAD SCOPING IS DERIVED, NOT STORED (docs/PROVENANCE-SPEC.md §3). `m<id>` is
// Signal's global messages.rowid — one insertion stream across every conversation
// — so an unfiltered id span scoops up unrelated chats; a contact's own messages
// are 2-6% of their ledger's id span. The range therefore means
// `conv_id = thread(start) AND id BETWEEN start AND end`, resolved against the
// ARCHIVE, and the gaps that leaves (ids of other conversations, ids never
// mirrored) are normal rather than errors. The 20 thread messages before the
// range and the 10 after are shown dimmed; only in-range rows are the citation.
function spanPage(start, end) {
  if (end < start) return null;
  let cdb;
  try { cdb = openCrmDb(); } catch { return null; }
  try {
    let anchor = null;
    try { anchor = cdb.prepare('SELECT * FROM messages WHERE id = ?').get(start); } catch { /* archive table not created yet */ }
    if (!anchor) return null;
    // A row archived before conv_id existed cannot be thread-filtered; show the
    // one message rather than nothing.
    const rows = anchor.conv_id
      ? cdb.prepare('SELECT * FROM messages WHERE conv_id = ? AND id BETWEEN ? AND ? ORDER BY id')
          .all(anchor.conv_id, start, end)
      : [anchor];
    // Context flanking the range. Ordering by id is enough here: the range query
    // itself is id-ordered, so the whole page reads in one consistent order.
    const before = anchor.conv_id
      ? cdb.prepare('SELECT * FROM messages WHERE conv_id = ? AND id < ? ORDER BY id DESC LIMIT 20')
          .all(anchor.conv_id, start).reverse()
      : [];
    const after = anchor.conv_id
      ? cdb.prepare('SELECT * FROM messages WHERE conv_id = ? AND id > ? ORDER BY id ASC LIMIT 10')
          .all(anchor.conv_id, end)
      : [];
    const dim = new Set([...before, ...after].map((m) => m.id));
    const backHref = anchor.contact_slug ? `/c/${encodeURIComponent(anchor.contact_slug)}` : '/';
    const span = `m${start}&ndash;m${end}`;
    const body = `<div class="back"><a href="${backHref}">&larr; back</a></div>` +
      `<div class="profile"><h1>${esc(anchor.conversation || 'Conversation')}</h1>` +
      `<p class="sub">cited range <code>${span}</code> &middot; ` +
      `${rows.length} message${rows.length === 1 ? '' : 's'} in this conversation` +
      `${anchor.conv_id ? ', shown with surrounding context' : ' (no conversation recorded for this row)'}</p>` +
      `<div class="charge">${msgBubbles(cdb, [...before, ...rows, ...after], null, dim)}</div></div>` +
      SCROLL_TO_HIT;
    return page(`m${start}-m${end} — ${anchor.conversation || 'range'}`, body, '/');
  } finally {
    try { cdb.close(); } catch { /* already closed */ }
  }
}

// ---- relationship graph -------------------------------------------------------
// Read-only node-link view of who mentions whom (lib/schema mentionEdges), a
// per-edge citation panel (edgeCitations), and a correction flow that relinks
// one citation to a different person (POST /graph/reassign). Everything is
// server-rendered inline SVG + a table fallback -- no client-side graph library.

// slug -> display name, straight off the contacts table (same lookup crm-web
// uses everywhere else), plus the synthetic 'nathan' node the scanner also uses.
function graphNameMap(cdb) {
  const m = new Map();
  // TRACKED people only (lib/person): an untracked stub row never becomes a graph node
  // or a dropdown option. OWNER is added explicitly (he has no profile-about-him).
  try { for (const c of PERSON.trackedContacts(cdb)) m.set(c.slug, c.name || c.slug); } catch { /* no contacts yet */ }
  m.set(OWNER_SLUG, 'Nathan');
  return m;
}
// Missing slugs fall back to the slug itself so a stale/renamed contact never
// breaks the render.
function graphNameFor(nameBySlug, slug) {
  if (slug === OWNER_SLUG) return 'Nathan';
  return nameBySlug.get(slug) || slug;
}

// GET /graph — the diagram + the reliable table fallback below it.
function graphPage(opts = {}) {
  const hideMine = !!opts.hideMine;
  const hideDm = !!opts.hideDm;
  // Carried onto every edge link so a filter survives a click into an edge page.
  const edgeSuffix = (hideMine ? '&mine=0' : '') + (hideDm ? '&dm=0' : '');
  let cdb;
  try { cdb = openCrmDb(); } catch { cdb = null; }
  let edges = [];
  let nameBySlug = new Map();
  try {
    if (cdb) {
      edges = mentionEdges(cdb, { hideMine, hideDm });
      nameBySlug = graphNameMap(cdb);
    }
  } finally {
    if (cdb) { try { cdb.close(); } catch { /* already closed */ } }
  }

  // Two view filters (default off): hide the mentions Nathan speaks, and hide the trivial
  // case of naming the other party in your own 1:1. Each link flips one flag.
  const gq = (m, d) => { const p = []; if (m) p.push('mine=0'); if (d) p.push('dm=0'); return p.length ? `?${p.join('&')}` : ''; };
  const controls = '<p class="sub">Filters: '
    + `<a href="/graph${gq(!hideMine, hideDm)}">${hideMine ? 'show' : 'hide'} my mentions</a>`
    + ` &middot; <a href="/graph${gq(hideMine, !hideDm)}">${hideDm ? 'show' : 'hide'} naming the other person in a 1:1</a>`
    + ((hideMine || hideDm) ? ' &middot; <a href="/graph">reset</a>' : '')
    + '</p>';

  const caption = '<p class="sub">Every edge is one person mentioning another, by name, in your archived '
    + 'messages &middot; click an edge to see the citations.</p>';

  if (!edges.length) {
    const empty = (hideMine || hideDm)
      ? '<p>No edges match the current filters.</p>'
      : '<p>No mentions recorded yet &mdash; this fills in after the next sweep runs the mention scan.</p>';
    const body = `<div class="profile"><h1>Relationship graph</h1>${caption}${controls}${empty}</div>`;
    return page('Relationship graph — personal-crm', body, '/graph');
  }

  // Node set = every slug touched by an edge, weighted by total citations through
  // it (either direction) so hubs read as bigger circles.
  const weight = new Map();
  const bump = (slug, n) => weight.set(slug, (weight.get(slug) || 0) + n);
  for (const e of edges) { bump(e.from_slug, e.n); bump(e.to_slug, e.n); }
  const slugs = [...weight.keys()];
  // Stable order (degree desc, then slug) so the layout doesn't jitter between
  // renders of the same data.
  slugs.sort((a, b) => (weight.get(b) - weight.get(a)) || (a < b ? -1 : a > b ? 1 : 0));

  const W = 900, H = 640, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 90;
  const N = slugs.length;
  const pos = new Map();
  slugs.forEach((slug, i) => {
    const theta = N === 1 ? -Math.PI / 2 : (2 * Math.PI * i) / N - Math.PI / 2;
    pos.set(slug, { x: cx + R * Math.cos(theta), y: cy + R * Math.sin(theta) });
  });

  const weights = [...weight.values()];
  const maxW = Math.max(...weights), minW = Math.min(...weights);
  const nodeR = (slug) => {
    const w = weight.get(slug);
    const t = maxW === minW ? 0.5 : (Math.sqrt(w) - Math.sqrt(minW)) / (Math.sqrt(maxW) - Math.sqrt(minW));
    return 10 + t * 18; // 10..28px, sqrt so AREA tracks weight
  };

  const ns = edges.map((e) => e.n);
  const maxN = Math.max(...ns), minN = Math.min(...ns);
  const strokeW = (n) => {
    const t = maxN === minN ? 0.5 : (n - minN) / (maxN - minN);
    return 1.5 + t * 6.5; // 1.5..8px, clamped to stay readable
  };

  // Edges as gentle quadratic curves. Mentions are split by speaker, so A->B and
  // B->A can both exist; offset the control point perpendicular to the line, with
  // the sign fixed by slug order, so the two directions never sit on top of each
  // other. Endpoints are pulled back to each node's rim so the arrowhead lands
  // cleanly outside the circle instead of under it.
  const edgeSvg = edges.map((e) => {
    const a = pos.get(e.from_slug), b = pos.get(e.to_slug);
    if (!a || !b) return ''; // defensive: never throw on a row geometry can't place
    const fromName = graphNameFor(nameBySlug, e.from_slug);
    const toName = graphNameFor(nameBySlug, e.to_slug);
    const href = `/graph/edge?from=${encodeURIComponent(e.from_slug)}&to=${encodeURIComponent(e.to_slug)}${edgeSuffix}`;
    const titleTxt = `${fromName} → ${toName} · ${e.n} mention${e.n === 1 ? '' : 's'}`;
    let d;
    if (e.from_slug === e.to_slug) {
      // Self-mention (rare, but the schema allows it): a small loop above the node.
      const r0 = nodeR(e.from_slug);
      d = `M ${(a.x - r0).toFixed(1)} ${a.y.toFixed(1)} C ${(a.x - r0 - 26).toFixed(1)} ${(a.y - 40).toFixed(1)}, `
        + `${(a.x + r0 + 26).toFixed(1)} ${(a.y - 40).toFixed(1)}, ${(a.x + r0).toFixed(1)} ${a.y.toFixed(1)}`;
    } else {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const sign = e.from_slug < e.to_slug ? 1 : -1;
      const offset = 18 * sign;
      const px = (-dy / len) * offset, py = (dx / len) * offset;
      const ra = nodeR(e.from_slug), rb = nodeR(e.to_slug);
      const sx = a.x + ux * ra, sy = a.y + uy * ra;
      const ex = b.x - ux * (rb + 8), ey = b.y - uy * (rb + 8);
      const mx = (sx + ex) / 2 + px, my = (sy + ey) / 2 + py;
      d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`;
    }
    return `<a href="${esc(href)}"><path d="${d}" fill="none" stroke="var(--stamp)" `
      + `stroke-width="${strokeW(e.n).toFixed(1)}" stroke-opacity="0.55" marker-end="url(#arrow)">`
      + `<title>${esc(titleTxt)}</title></path></a>`;
  }).join('');

  const nodeSvg = slugs.map((slug) => {
    const p = pos.get(slug);
    const r = nodeR(slug);
    const name = graphNameFor(nameBySlug, slug);
    const isOwner = slug === OWNER_SLUG;
    return '<g>'
      + `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" `
      + `fill="${isOwner ? 'var(--stamp)' : 'var(--card)'}" stroke="var(--ink)" stroke-width="1.2">`
      + `<title>${esc(name)}</title></circle>`
      + `<text x="${p.x.toFixed(1)}" y="${(p.y + r + 14).toFixed(1)}" text-anchor="middle" font-size="11" `
      + `fill="var(--ink)">${esc(name)}</text></g>`;
  }).join('');

  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" `
    + 'aria-label="Relationship graph" style="max-width:100%;background:var(--paper);border:1px solid var(--rule);border-radius:8px">'
    + '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
    + '<path d="M0,0 L10,5 L0,10 z" fill="var(--stamp)" fill-opacity="0.7"/></marker></defs>'
    + edgeSvg + nodeSvg + '</svg>';

  // Table fallback: same edges, most-weighted first, every row a link. This is
  // what makes the feature usable even where SVG hit-testing is fiddly.
  const rows = [...edges].sort((x, y) => (y.n - x.n) || (y.last - x.last)).map((e) => {
    const href = `/graph/edge?from=${encodeURIComponent(e.from_slug)}&to=${encodeURIComponent(e.to_slug)}${edgeSuffix}`;
    return `<tr><td><a href="${esc(href)}">${esc(graphNameFor(nameBySlug, e.from_slug))}</a></td><td>&rarr;</td>`
      + `<td><a href="${esc(href)}">${esc(graphNameFor(nameBySlug, e.to_slug))}</a></td>`
      + `<td class="num">${e.n}</td><td>${esc(ptLocal(e.last))}</td></tr>`;
  }).join('');
  const table = `<table class="tbl"><tr><th>From</th><th></th><th>To</th><th>mentions</th><th>last</th></tr>${rows}</table>`;

  const body = `<div class="profile"><h1>Relationship graph</h1>${caption}${controls}${svg}<h2>All edges</h2>${table}</div>`;
  return page('Relationship graph — personal-crm', body, '/graph');
}

// GET /graph/edge?from=&to= — every citation behind one directed edge, newest
// first, each with a compact "link this citation to someone else" form.
function edgePage(fromSlug, toSlug, opts = {}) {
  const hideMine = !!opts.hideMine;
  const hideDm = !!opts.hideDm;
  const backSuffix = (hideMine ? '&mine=0' : '') + (hideDm ? '&dm=0' : '');
  let cdb;
  try { cdb = openCrmDb(); } catch { cdb = null; }
  let cites = [];
  let nameBySlug = new Map();
  let allSlugs = [];
  try {
    if (cdb) {
      cites = edgeCitations(cdb, fromSlug, toSlug, { hideMine, hideDm });
      nameBySlug = graphNameMap(cdb);
      allSlugs = [...nameBySlug.keys()];
      if (!allSlugs.includes(OWNER_SLUG)) allSlugs.push(OWNER_SLUG);
      allSlugs.sort((a, b) => graphNameFor(nameBySlug, a).localeCompare(graphNameFor(nameBySlug, b)));
    }
  } finally {
    if (cdb) { try { cdb.close(); } catch { /* already closed */ } }
  }

  const fromName = graphNameFor(nameBySlug, fromSlug);
  const toName = graphNameFor(nameBySlug, toSlug);
  const options = allSlugs.map((s) => `<option value="${esc(s)}">${esc(graphNameFor(nameBySlug, s))}</option>`).join('');

  const rows = cites.map((c) => {
    const when = esc(ptLocal(c.observed_at));
    const meta = [c.sender, c.conversation].filter(Boolean).map(esc).join(' &middot; ');
    let snippet;
    if (c.body) {
      const s = String(c.body);
      snippet = esc(s.length > 240 ? `${s.slice(0, 240)}…` : s);
    } else {
      snippet = '<em>(message not in archive)</em>';
    }
    // Only 'scan' citations are correctable: the reassign machinery (override +
    // live move) applies to scan rows, and a rebuild would duplicate a corrected
    // 'model' row onto both edges. Legacy imported rows are shown, not editable.
    const action = c.source === 'scan'
      ? '<form method="POST" action="/graph/reassign" style="display:flex;gap:6px;align-items:center;margin:0">'
        + `<input type="hidden" name="from" value="${esc(fromSlug)}">`
        + `<input type="hidden" name="orig_to" value="${esc(toSlug)}">`
        + `<input type="hidden" name="src_msg" value="${esc(c.src_msg)}">`
        + `<select name="new_to"><option value="" selected disabled>choose a person&hellip;</option>${options}</select>`
        + '<button type="submit">link to&hellip;</button>'
        + '</form>'
      : '<span class="sub">imported edge &middot; not editable</span>';
    return '<div class="card" style="margin:10px 0;padding:10px 12px">'
      + `<div class="sub">${when}${meta ? ` &middot; ${meta}` : ''}</div>`
      + `<div>${snippet}</div>`
      + '<div style="margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + `<a href="/m/${esc(c.src_msg)}" target="_blank" rel="noopener">view thread &rarr;</a>`
      + action + '</div></div>';
  }).join('');

  const body = `<div class="back"><a href="/graph${backSuffix ? `?${backSuffix.replace(/^&/, '')}` : ''}">&larr; back to graph</a></div>`
    + `<div class="profile"><h1>${esc(fromName)} &rarr; ${esc(toName)}</h1>`
    + `<p class="sub">${cites.length} citation${cites.length === 1 ? '' : 's'}, newest first</p>`
    + (cites.length ? rows : '<p>No citations recorded for this edge.</p>')
    + '</div>';
  return page(`${fromName} → ${toName} — graph`, body, '/graph');
}

// ---- profile page, with per-unit hand editing --------------------------------
// The profile is plain Markdown on disk, so "edit" means editing that Markdown
// directly. The edit unit is the SUBSECTION: each `###` block (School, Money,
// Family…) and each `##` section without `###` children (Talking points, Open
// questions) carries a pencil that only appears on hover, and clicking it makes
// that unit's text editable in place — the rendered view swaps for a seamless
// editable area holding the unit's raw source, no chrome. The two hand-owned
// header fields (Relationship, Birthday) edit the same way, inline. All pending
// changes share ONE state: a quiet bottom bar appears with Cancel (discard
// everything), Diff (PR-style line diff, inline or side-by-side), and Save
// (one manual run).

// Split a profile into its header (title + metadata, before the first heading)
// and its edit units at `##`/`###` boundaries. Spans are [from, to) line indexes
// into `lines`. The same split feeds assemble() in PROFILE_EDIT_JS client-side —
// keep them in step.
function splitProfile(md) {
  const lines = md.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i += 1) if (/^###? /.test(lines[i])) marks.push(i);
  const units = marks.map((from, k) => ({
    from,
    to: k + 1 < marks.length ? marks[k + 1] : lines.length,
    heading: lines[from].replace(/^#+\s+/, '').trim(),
    level: lines[from].startsWith('###') ? 3 : 2,
  }));
  return { lines, headerTo: marks.length ? marks[0] : lines.length, units };
}

// A unit's canonical text: its lines with trailing blank lines stripped, so what
// the editable area holds is exactly what a save writes back (assemble adds the
// one blank line that separates blocks).
function sectionText(lines, span) {
  const seg = lines.slice(span.from, span.to);
  while (seg.length && seg[seg.length - 1].trim() === '') seg.pop();
  return seg.join('\n');
}

// Message-date resolver for ⟨m… ts⟩ age stamps: the newest cited message's
// sent_at, from the archive. One connection + prepared statement per render,
// results cached per id; close() once the page is built. No archive yet means
// every id resolves null and stamps simply stay off.
function msgDates() {
  let cdb = null;
  let q = null;
  try { cdb = openCrmDb(); q = cdb.prepare('SELECT sent_at FROM messages WHERE id = ?'); } catch { /* no db */ }
  const cache = new Map();
  return {
    dateFor(id) {
      if (!cache.has(id)) {
        let ms = null;
        if (q) { try { const r = q.get(id); ms = r ? r.sent_at : null; } catch { /* archive table not created yet */ } }
        cache.set(id, ms);
      }
      return cache.get(id);
    },
    close() { if (cdb) { try { cdb.close(); } catch { /* closed */ } } },
  };
}

// ---- header helpers ---------------------------------------------------------
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtN = (n) => Number(n).toLocaleString('en-US');
// "+18587538808" reads as a machine string; group it the way a person dials it.
function fmtPhone(p) {
  const m = String(p).match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : String(p);
}
// Line icons for the two dated/contact fields — monochrome, currentColor, no
// emoji (matches the ledger's house style). A cake for birthday, a handset for
// phone; decorative, so aria-hidden (the pencil already labels the field).
const CAKE_IC = '<svg class="cl-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h18"/><path d="M5 20v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7"/><path d="M5 14.4c1.4 1.1 2.6 1.1 4 0s2.6-1.1 4 0 2.6 1.1 4 0"/><path d="M12 8V5.2"/><circle cx="12" cy="3.4" r=".95" fill="currentColor" stroke="none"/></svg>';
const PHONE_IC = '<svg class="cl-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.8 3.5H4.5A1.5 1.5 0 0 0 3 5.2C3 13.4 10.6 21 18.8 21a1.5 1.5 0 0 0 1.7-1.5v-2.3a1 1 0 0 0-.86-1l-2.9-.4a1 1 0 0 0-1 .43l-.8 1.1a12.5 12.5 0 0 1-5.3-5.3l1.1-.8a1 1 0 0 0 .43-1l-.4-2.9a1 1 0 0 0-1-.86Z"/></svg>';
// The runway: one bar per Pacific calendar month, from the first archived
// message's month through the current month (Nathan settled on monthly bars,
// 2026-08-11 — the count grows with the history). Buckets are computed in JS
// via ptDateKey because a month boundary is a Pacific-midnight fact no fixed
// UTC offset gets right in both halves of the year. Returns
// [{ key: 'YYYY-MM', n }] or null.
function activityMonths(slug, now) {
  let cdb;
  try { cdb = openCrmDb(); } catch { return null; }
  try {
    let rows;
    try {
      rows = cdb.prepare('SELECT sent_at FROM messages WHERE contact_slug = ?').all(slug);
    } catch { return null; }
    if (!rows.length) return null;
    const counts = new Map(); // 'YYYY-MM' -> n
    let minKey = null;
    for (const r of rows) {
      const k = ptDateKey(r.sent_at).slice(0, 7);
      counts.set(k, (counts.get(k) || 0) + 1);
      if (!minKey || k < minKey) minKey = k;
    }
    const nowKey = ptDateKey(now).slice(0, 7);
    if (minKey > nowKey) return null;
    const months = [];
    let [y, m] = minKey.split('-').map(Number);
    const [ny, nm] = nowKey.split('-').map(Number);
    while (y < ny || (y === ny && m <= nm)) {
      const k = `${y}-${String(m).padStart(2, '0')}`;
      months.push({ key: k, n: counts.get(k) || 0 });
      m += 1;
      if (m === 13) { m = 1; y += 1; }
    }
    return months;
  } finally {
    try { cdb.close(); } catch { /* closed */ }
  }
}

function profilePage(slug) {
  const file = path.posix.join(CONTACTS_DIR, `${slug}.md`);
  let md;
  try { md = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const baseHash = crypto.createHash('sha256').update(md).digest('hex');
  const { lines, headerTo, units } = splitProfile(md);
  const titleLine = lines.find((l) => l.startsWith('# '));
  const name = titleLine ? titleLine.slice(2).trim() : slug;

  const pencil = (label) => `<button type="button" class="ebtn" title="edit ${esc(label)}" aria-label="edit ${esc(label)}">&#9998;</button>`;

  // Header: the dossier's face (Claude Design spec, second pass 2026-08-11).
  // Left, the identity block: name, relationship epigraph, then birthday and
  // phone as bare mono lines — no icons, no field labels (the Signal uuid is
  // meaningless to a human and lives only in the file). Right, a ~400px column:
  // the monthly runway (one bar per calendar month of contact, "N MO OF
  // CONTACT ——— NOW" beneath) over the boxed last-contact stamp. Then the
  // hairline and the stats row — hero plus topics/openers/sources/stale. The
  // three hand-owned fields (EDITABLE_FIELDS: Relationship, Birthday, Phone)
  // keep the hover pencil and render even when the file lacks them — a save
  // inserts the bullet.
  const meta = new Map(); // metadata bullets, label -> value
  let h1 = `<h1>${esc(name)}</h1>`;
  const strays = [];
  for (const line of lines.slice(0, headerTo)) {
    const t = line.trim();
    if (t === '') continue;
    if (t.startsWith('# ')) { h1 = `<h1>${mdInline(t.slice(2))}</h1>`; continue; }
    const m = t.match(/^-\s+\*\*([^:*]+):\*\*\s*(.+)$/);
    if (m) { meta.set(m[1].trim(), m[2].trim()); continue; }
    strays.push(`<p>${mdInline(t)}</p>`);
  }
  // LIVE STATS, bot-excluded. "Last contact" and "Messages" are otherwise stale
  // .md snapshots from the last merge — and both counted Janet's messages in a
  // me+contact+bot group (which the archive already folds into the contact via
  // contact_slug). Recompute from the archive: last contact is the newest message
  // from a human (src IS NOT the bot — NULL-safe), and the total/split drops the
  // bot too (from_them = everything attributed to this contact that isn't me).
  try {
    const statDb = openCrmDb();
    try {
      const lc = statDb.prepare('SELECT MAX(sent_at) mx FROM messages WHERE contact_slug = ? AND src IS NOT ?').get(slug, BOT_SERVICE_ID);
      if (lc && lc.mx) meta.set('Last contact', ptDateKey(lc.mx));
      // From me/them by DIRECTION (type), reliable regardless of which serviceId a
      // message was sent under; calls aren't messages, so the total is just
      // outgoing+incoming. The bot is dropped (src IS NOT the bot — NULL-safe).
      const mine = statDb.prepare("SELECT COUNT(*) n FROM messages WHERE contact_slug = ? AND type = 'outgoing' AND src IS NOT ?").get(slug, BOT_SERVICE_ID).n;
      const theirs = statDb.prepare("SELECT COUNT(*) n FROM messages WHERE contact_slug = ? AND type = 'incoming' AND src IS NOT ?").get(slug, BOT_SERVICE_ID).n;
      if (mine + theirs > 0) meta.set('Messages', `${mine + theirs} total (${theirs} from them, ${mine} from me)`);
    } finally { statDb.close(); }
  } catch { /* fall back to the stored .md values */ }
  // `show` overrides the display form only — the input always edits the raw
  // stored value (the phone renders grouped but is stored as one token).
  const fieldHtml = (label, key, cur, show) =>
    `<span class="efield-val">${show ?? mdInline(cur == null ? '_TBD_' : cur)}</span>`
    + `<textarea class="efield-input" hidden maxlength="120" rows="1" aria-label="${esc(label)}">${esc(cur == null || cur === '_TBD_' ? '' : cur)}</textarea>`
    + pencil(label);

  const now = Date.now();
  const todayKey = ptDateKey(now);
  const dkey = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

  // Left column: epigraph + contact lines. Unplaced metadata joins the contact
  // block as plain lines so a hand-added bullet never disappears.
  const rel = `<div class="rel efield" data-key="relationship" data-label="Relationship">`
    + fieldHtml('Relationship', 'relationship', meta.get('Relationship') ?? null) + '</div>';
  const phoneRaw = meta.get('Phone') ?? null;
  const clines = [
    `<div class="cline">${CAKE_IC}<span class="efield" data-key="birthday" data-label="Birthday">`
      + fieldHtml('Birthday', 'birthday', meta.get('Birthday') ?? null) + '</span></div>',
    `<div class="cline">${PHONE_IC}<span class="efield" data-key="phone" data-label="Phone">`
      + fieldHtml('Phone', 'phone', phoneRaw, phoneRaw == null ? null : esc(fmtPhone(phoneRaw))) + '</span></div>',
  ];
  const PLACED = new Set(['Relationship', 'Birthday', 'First contact', 'Last contact', 'Messages', 'Phone', 'Signal ID']);
  for (const [label, v] of meta) if (!PLACED.has(label)) {
    clines.push(`<div class="cline"><span>${esc(label.toLowerCase())} <b>${mdInline(v)}</b></span></div>`);
  }

  // Right column: the boxed last-contact stamp (the runway joins it below,
  // once the archive has been consulted).
  let stamp = '';
  const lastKey = dkey(meta.get('Last contact'));
  if (lastKey) {
    const [, mo, d] = lastKey.split('-').map(Number);
    const ago = Math.round((Date.parse(todayKey) - Date.parse(lastKey)) / 86_400_000);
    const agoTxt = ago <= 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago`;
    stamp = `<div class="lstamp"><span class="ls-k">last contact</span>`
      + `<span class="ls-d">${MON3[mo - 1]} ${d}</span><span class="ls-ago">${agoTxt}</span></div>`;
  }

  // Counts for the stats row, from the file itself: What-I-know topics,
  // Talking-points openers, distinct cited source messages.
  let topics = 0;
  let openers = 0;
  let curSec = '';
  for (const l of lines) {
    const h2 = l.match(/^## (.+)$/);
    if (h2) { curSec = h2[1].trim().toLowerCase(); continue; }
    if (/^### /.test(l) && curSec === 'what i know') topics += 1;
    else if (/^[-*] /.test(l.trim()) && curSec === 'what i know') topics += 1;
    else if (/^[-*] /.test(l.trim()) && curSec === 'talking points') openers += 1;
  }
  const CITES = /⟨\s*m(\d+)(?:-m(\d+))?(?:\s+@m(\d+))?(?:\s+ts)?\s*⟩/g;
  const sources = new Set([...md.matchAll(CITES)].map((c) => c[2] || c[1])).size;

  // ⟨m… ts⟩ slips need message dates from the archive; stale (ts claims past
  // the 6-month line) is the caution cell at the end of the cluster.
  const dates = msgDates();
  try {
    const mdOpts = { dateFor: dates.dateFor, now };
    const stale = staleCount(md, mdOpts);

    // The runway: one bar per calendar month of the whole history, stamp-blue
    // when the month beat the median. Native title = "Aug 2025 — 462 messages";
    // the caption names the month count, with NOW pinned at the hairline's end.
    let runway = '';
    const months = activityMonths(slug, now);
    if (months && months.some((b) => b.n)) {
      const vals = months.map((b) => b.n).sort((a, b) => a - b);
      const mid = vals.length % 2
        ? vals[(vals.length - 1) / 2]
        : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
      const max = Math.max(...vals);
      const bars = months.map((b) => {
        const [y, mo] = b.key.split('-').map(Number);
        const tip = `${MON3[mo - 1]} ${y} — ${fmtN(b.n)} message${b.n === 1 ? '' : 's'}`;
        const hgt = b.n ? Math.max(Math.round((b.n / max) * 100), 8) : 0;
        return `<span class="bar${b.n > mid ? ' busy' : ''}" style="height:${hgt}%" title="${tip}" aria-label="${tip}"></span>`;
      }).join('');
      runway = `<div class="runway"><div class="bars">${bars}</div>`
        + `<div class="rw-cap"><span>${months.length} mo of contact</span>`
        + '<i class="rw-line"></i><span class="rw-now">now</span></div></div>';
    }

    // Nicknames sit in the identity column, under the contact lines. Always rendered
    // (V.Nicks keeps a "+ nickname" affordance even when empty); each one's cites resolve
    // to the same date-faced slips as a fact bullet.
    const nicks = P.listNicknames(slug).map((n) => ({ ...n, cites: nickCites(n.cites, dates, now) }));
    const nickHtml = render(V.Nicks(nicks));

    const header = [];
    header.push(`<div class="phead-top"><div class="phead-id">${h1}${rel}`
      + `<div class="contact">${clines.join('')}</div>${nickHtml}</div>`
      + (runway || stamp ? `<div class="phead-right">${runway}${stamp}</div>` : '')
      + '</div>');
    header.push(...strays);

    // Stats row: the message hero (them/me split waits on hover, in reserved
    // space so nothing shifts), then the tight four-count cluster.
    let hero = '';
    const mv = meta.get('Messages') || '';
    const mm = mv.match(/^(\d+) total \((\d+) from them, (\d+) from me\)$/);
    if (mm) {
      const first = esc(name.split(/\s+/)[0]);
      hero = `<div class="hero"><span class="n">${fmtN(mm[1])}</span><div class="sub">`
        + '<span class="statlab lab">messages</span>'
        + `<span class="msplit"><b>${fmtN(mm[2])}</b><i>from ${first}</i><b>${fmtN(mm[3])}</b><i>from me</i></span>`
        + '</div></div>';
    } else if (mv) {
      hero = `<div class="hero"><span class="n">${mdInline(mv)}</span><div class="sub"><span class="statlab">messages</span></div></div>`;
    }
    const cell = (n, lab, warn) =>
      `<div class="cell${warn ? ' warn' : ''}"><span class="n">${fmtN(n)}</span><span class="statlab">${esc(lab)}</span></div>`;
    const cluster = `<div class="cluster">${cell(topics, 'topics')}${cell(openers, 'openers')}`
      + `${cell(sources, 'sources')}${cell(stale, 'stale', stale > 0)}</div>`;
    header.push('<hr class="phead-rule">');
    header.push(`<div class="statrow">${hero}${cluster}</div>`);

    // Units render in file order. A bare `##` heading line whose subsections
    // carry the content (`## What I know`, `## Timeline`) is structure, not
    // text — it renders plain, with no pencil. Everything else gets the pencil
    // tucked into its own heading, visible only on hover.
    const unitHtml = units.map((u, i) => {
      const text = sectionText(lines, u);
      if (u.level === 2 && text === lines[u.from].trimEnd()) return renderProfile(text, mdOpts);
      // Structured facts are the source of truth; this section is rendered from
      // crm.db after merges and is intentionally not hand-editable as prose.
      if (u.level === 2 && u.heading === 'What I know') return renderProfile(text, mdOpts);
      const view = renderProfile(text, mdOpts).replace(/<\/h([23])>/, `${pencil(u.heading)}</h$1>`);
      return `<section class="eunit" data-idx="${i}" data-heading="${esc(u.heading)}">`
        + `<div class="eview">${view}</div>`
        + `<textarea class="esrc" hidden spellcheck="false" aria-label="edit ${esc(u.heading)}">${esc(text)}</textarea>`
        + `</section>`;
    }).join('');

    const bar = `<div class="editbar" id="editbar" hidden>`
      + `<span class="editbar-n" id="editbarN"></span>`
      + `<button type="button" class="btn sm" id="btnDiff">Diff</button>`
      + `<button type="button" class="btn sm" id="btnCancel">Cancel</button>`
      + `<span class="whyrow" id="whyRow" hidden><label class="whyk" for="whyIn">for the record</label>`
      + `<input class="whyin" id="whyIn" maxlength="500" placeholder="why this change" autocomplete="off"></span>`
      + `<button type="button" class="btn sm pr" id="btnSave">Save</button></div>`;

    const modal = `<div class="modal" id="diffModal" hidden><div class="diffcard">`
      + `<div class="diffhead"><h2>Unsaved changes — ${esc(name)}</h2>`
      + `<span class="dmode"><button type="button" class="btn sm" id="dmInline">inline</button>`
      + `<button type="button" class="btn sm" id="dmSplit">side by side</button></span>`
      + `<button type="button" class="btn sm" id="dmClose">close</button></div>`
      + `<div class="diffbody" id="diffBody"></div></div></div>`;

    const cfg = { slug, baseHash, orig: md, headerTo, units: units.map((u) => ({ from: u.from, to: u.to, heading: u.heading })) };
    const cfgJs = `<script>window.__EDIT_CFG=${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script>`;

    const body = `<div class="back"><a href="/">&larr; All people</a>`
      + ` &middot; <a href="/c/${encodeURIComponent(slug)}/history">History &rarr;</a></div>`
      + `<div class="profile">${header.join('')}${unitHtml}</div>${bar}${modal}`;
    return page(name, body + cfgJs + PROFILE_EDIT_JS + NN_JS, '/');
  } finally {
    dates.close();
  }
}

// GET /me — the owner's own page. Just the nickname block for OWNER_SLUG, reusing
// the same NN_JS/.nn machinery as a contact profile (SLUG comes from __EDIT_CFG).
function mePage() {
  const dates = msgDates();
  let nicks;
  try {
    const now = Date.now();
    nicks = P.listNicknames(OWNER_SLUG).map((n) => ({ ...n, cites: nickCites(n.cites, dates, now) }));
  } finally {
    dates.close();
  }
  const v = V.me(nicks);
  const cfgJs = `<script>window.__EDIT_CFG=${JSON.stringify({ slug: OWNER_SLUG }).replace(/</g, '\\u003c')}</script>`;
  return page(v.title, render(v.body) + cfgJs + NN_JS);
}

// The whole edit state machine, in page. Mirrors the server exactly where it
// must: assemble() re-derives the saved file from the pristine Markdown plus the
// dirty units/fields, the same splice applyManualEdit performs — so the Diff
// overlay shows character-for-character what Save will commit.
const PROFILE_EDIT_JS = `<script>(function(){
  var CFG=window.__EDIT_CFG;if(!CFG)return;
  var units=[].slice.call(document.querySelectorAll('.eunit'));
  var flds=[].slice.call(document.querySelectorAll('.efield'));
  var bar=document.getElementById('editbar'),barN=document.getElementById('editbarN');
  var modal=document.getElementById('diffModal'),diffBody=document.getElementById('diffBody');
  var mode=window.matchMedia('(min-width: 980px)').matches?'split':'inline';

  function normSec(v){return v.replace(/\\r/g,'').replace(/^\\n+/,'').replace(/\\n+$/,'');}
  function normFld(v){return v.replace(/[\\r\\n]+/g,' ').trim().slice(0,120);}
  function dirtyUnits(){return units.filter(function(u){var ta=u.querySelector('.esrc');return normSec(ta.value)!==ta.defaultValue;});}
  function dirtyFlds(){return flds.filter(function(f){var inp=f.querySelector('.efield-input');return normFld(inp.value)!==inp.defaultValue;});}

  function refresh(){
    var du=dirtyUnits(),df=dirtyFlds(),n=du.length+df.length;
    units.forEach(function(u){u.classList.toggle('dirty',du.indexOf(u)!==-1);});
    flds.forEach(function(f){f.classList.toggle('dirty',df.indexOf(f)!==-1);});
    bar.hidden=n===0;
    if(n)barN.textContent=n+' unsaved change'+(n===1?'':'s');
    else disarmWhy();
  }

  // ---- in-place editing: pencil opens, Escape closes (changes kept) ----
  function size(ta){ta.style.height='auto';ta.style.height=(ta.scrollHeight+2)+'px';}
  function openUnit(u){
    var ta=u.querySelector('.esrc');
    u.classList.add('editing');
    u.querySelector('.eview').hidden=true;
    ta.hidden=false;size(ta);ta.focus();
  }
  function closeUnit(u){
    u.classList.remove('editing');
    u.querySelector('.eview').hidden=false;
    u.querySelector('.esrc').hidden=true;
    rerender(u);
    refresh();
  }
  // The reading view must show what the editor now holds, not what the page
  // loaded with. The server renders the edited Markdown with the same
  // renderProfile the page itself uses; the live pencil node (listener and all)
  // moves into the fresh heading.
  function rerender(u){
    var view=u.querySelector('.eview'),ta=u.querySelector('.esrc');
    var text=normSec(ta.value);
    if(text===u.dataset.shown)return;
    fetch('/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text})})
      .then(function(r){return r.json();})
      .then(function(j){
        if(!j||!j.ok)return;
        var btn=u.querySelector('.ebtn');
        view.innerHTML=j.html;
        var h=view.querySelector('h2,h3');
        (h||view).appendChild(btn);
        u.dataset.shown=text;
      })
      .catch(function(){});
  }
  units.forEach(function(u){
    var ta=u.querySelector('.esrc');
    u.dataset.shown=ta.defaultValue;
    u.querySelector('.ebtn').addEventListener('click',function(){openUnit(u);});
    ta.addEventListener('input',function(){size(ta);refresh();});
    ta.addEventListener('keydown',function(e){if(e.key==='Escape'){e.stopPropagation();closeUnit(u);}});
  });
  function escText(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
  function closeFld(f){
    var inp=f.querySelector('.efield-input'),val=f.querySelector('.efield-val');
    f.classList.remove('editing');inp.hidden=true;val.hidden=false;
    var v=normFld(inp.value);
    val.innerHTML=v?escText(v):'<em>TBD</em>';
    refresh();
  }
  // The field editors are single-value textareas: they grow in height (never
  // width) as you type, but still commit one line — Enter commits with no newline
  // and closeFld's normFld strips any that slipped in. Escape reverts this field
  // to what the page loaded with (the global Cancel still resets everything).
  function sizeFld(inp){inp.style.height='auto';inp.style.height=inp.scrollHeight+'px';}
  flds.forEach(function(f){
    var inp=f.querySelector('.efield-input'),val=f.querySelector('.efield-val');
    var open=function(){f.classList.add('editing');val.hidden=true;inp.hidden=false;inp.focus();sizeFld(inp);};
    f.querySelector('.ebtn').addEventListener('click',open);
    val.addEventListener('click',open);
    inp.addEventListener('input',function(){sizeFld(inp);refresh();});
    inp.addEventListener('blur',function(){closeFld(f);});
    inp.addEventListener('keydown',function(e){
      if(e.key==='Enter'){e.preventDefault();e.stopPropagation();closeFld(f);}
      else if(e.key==='Escape'){e.stopPropagation();inp.value=inp.defaultValue;closeFld(f);}
    });
  });

  // ---- Cancel: everything back to what the page loaded with ----
  document.getElementById('btnCancel').addEventListener('click',function(){
    if(!confirm('Discard all unsaved changes?'))return;
    units.forEach(function(u){var ta=u.querySelector('.esrc');ta.value=ta.defaultValue;closeUnit(u);});
    flds.forEach(function(f){var inp=f.querySelector('.efield-input');inp.value=inp.defaultValue;closeFld(f);});
    refresh();
  });

  // ---- assemble: pristine Markdown + dirty edits -> the file a save writes ----
  // MIRRORS applyManualEdit in crm-web.js. Units splice bottom-up (spans stay
  // valid), each followed by the one separating blank line; an emptied editor
  // deletes its unit. Fields rewrite (or insert into) the header block.
  function assemble(){
    var lines=CFG.orig.split('\\n');
    dirtyUnits().sort(function(a,b){return b.dataset.idx-a.dataset.idx;}).forEach(function(u){
      var span=CFG.units[Number(u.dataset.idx)];
      var text=normSec(u.querySelector('.esrc').value);
      var repl=text===''?[]:text.split('\\n').concat(['']);
      lines.splice.apply(lines,[span.from,span.to-span.from].concat(repl));
    });
    dirtyFlds().forEach(function(f){
      var label=f.dataset.label;
      var value=normFld(f.querySelector('.efield-input').value)||'_TBD_';
      var headerEnd=lines.length;
      for(var i=0;i<lines.length;i++)if(/^## /.test(lines[i])){headerEnd=i;break;}
      var re=new RegExp('^- \\\\*\\\\*'+label+':\\\\*\\\\* (.*)$'),idx=-1;
      for(var j=0;j<headerEnd;j++)if(re.test(lines[j])){idx=j;break;}
      if(idx!==-1)lines[idx]='- **'+label+':** '+value;
      else{
        var k=0;
        for(var t=0;t<headerEnd;t++)if(lines[t].indexOf('# ')===0){k=t+1;break;}
        while(k<headerEnd&&(lines[k].trim()===''||lines[k].indexOf('- ')===0))k++;
        while(k>0&&lines[k-1].trim()==='')k--;
        lines.splice(k,0,'- **'+label+':** '+value);
      }
    });
    var out=lines.join('\\n');
    return out.slice(-1)==='\\n'?out:out+'\\n';
  }

  // ---- line diff (LCS with common prefix/suffix trim) ----
  function diffLines(a,b){
    var s=0;while(s<a.length&&s<b.length&&a[s]===b[s])s++;
    var e=0;while(e<a.length-s&&e<b.length-s&&a[a.length-1-e]===b[b.length-1-e])e++;
    var ac=a.slice(s,a.length-e),bc=b.slice(s,b.length-e),n=ac.length,m=bc.length;
    var dp=new Uint32Array((n+1)*(m+1)),W=m+1;
    for(var i=n-1;i>=0;i--)for(var j=m-1;j>=0;j--)
      dp[i*W+j]=ac[i]===bc[j]?dp[(i+1)*W+j+1]+1:Math.max(dp[(i+1)*W+j],dp[i*W+j+1]);
    var ops=[],x=0,y=0;
    for(var p=0;p<s;p++)ops.push({t:'=',a:p,b:p});
    while(x<n&&y<m){
      if(ac[x]===bc[y]){ops.push({t:'=',a:s+x,b:s+y});x++;y++;}
      else if(dp[(x+1)*W+y]>=dp[x*W+y+1]){ops.push({t:'-',a:s+x});x++;}
      else{ops.push({t:'+',b:s+y});y++;}
    }
    while(x<n){ops.push({t:'-',a:s+x});x++;}
    while(y<m){ops.push({t:'+',b:s+y});y++;}
    for(var z=0;z<e;z++)ops.push({t:'=',a:a.length-e+z,b:b.length-e+z});
    return ops;
  }

  // Group ops into hunks with 3 lines of context, like a PR.
  function hunks(ops){
    var CTX=3,out=[],cur=null,gap=0;
    for(var i=0;i<ops.length;i++){
      var op=ops[i];
      if(op.t==='='){
        if(cur){
          if(gap<CTX){cur.ops.push(op);gap++;}
          else{
            var more=false;
            for(var j=i;j<ops.length&&j<i+CTX+1;j++)if(ops[j].t!=='='){more=true;break;}
            if(more){cur.ops.push(op);gap=0;}
            else{out.push(cur);cur=null;gap=0;}
          }
        }
      }else{
        if(!cur){
          cur={ops:[]};
          for(var k=Math.max(0,i-CTX);k<i;k++)cur.ops.push(ops[k]);
        }
        cur.ops.push(op);gap=0;
      }
    }
    if(cur)out.push(cur);
    return out;
  }

  function escH(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function hunkHeader(h,cols){
    var oa=null,ob=null,na=0,nb=0;
    h.ops.forEach(function(o){
      if(o.a!=null){if(oa==null)oa=o.a;na++;}
      if(o.b!=null){if(ob==null)ob=o.b;nb++;}
    });
    return '<tr class="dhunk"><td colspan="'+cols+'">@@ -'+((oa==null?0:oa+1))+','+na+' +'+((ob==null?0:ob+1))+','+nb+' @@</td></tr>';
  }

  function renderInline(hs,A,B){
    var rows=[];
    hs.forEach(function(h){
      rows.push(hunkHeader(h,4));
      h.ops.forEach(function(o){
        if(o.t==='=')rows.push('<tr><td class="dn">'+(o.a+1)+'</td><td class="dn">'+(o.b+1)+'</td><td class="dsign"> </td><td class="dc">'+escH(A[o.a])+'</td></tr>');
        else if(o.t==='-')rows.push('<tr class="ddel"><td class="dn">'+(o.a+1)+'</td><td class="dn"></td><td class="dsign">-</td><td class="dc">'+escH(A[o.a])+'</td></tr>');
        else rows.push('<tr class="dadd"><td class="dn"></td><td class="dn">'+(o.b+1)+'</td><td class="dsign">+</td><td class="dc">'+escH(B[o.b])+'</td></tr>');
      });
    });
    return '<table class="dtab">'+rows.join('')+'</table>';
  }

  function renderSplit(hs,A,B){
    var rows=[];
    hs.forEach(function(h){
      rows.push(hunkHeader(h,4));
      var i=0;
      while(i<h.ops.length){
        var o=h.ops[i];
        if(o.t==='='){
          rows.push('<tr><td class="dn">'+(o.a+1)+'</td><td class="dc">'+escH(A[o.a])+'</td><td class="dn">'+(o.b+1)+'</td><td class="dc">'+escH(B[o.b])+'</td></tr>');
          i++;continue;
        }
        var del=[],add=[];
        while(i<h.ops.length&&h.ops[i].t==='-'){del.push(h.ops[i]);i++;}
        while(i<h.ops.length&&h.ops[i].t==='+'){add.push(h.ops[i]);i++;}
        for(var r=0;r<Math.max(del.length,add.length);r++){
          var L=del[r],R=add[r];
          rows.push('<tr>'
            +(L?'<td class="dn ddel">'+(L.a+1)+'</td><td class="dc ddel">'+escH(A[L.a])+'</td>':'<td class="dn"></td><td class="dc dgap"></td>')
            +(R?'<td class="dn dadd">'+(R.b+1)+'</td><td class="dc dadd">'+escH(B[R.b])+'</td>':'<td class="dn"></td><td class="dc dgap"></td>')
            +'</tr>');
        }
      }
    });
    return '<table class="dtab split">'+rows.join('')+'</table>';
  }

  function showDiff(){
    var A=CFG.orig.split('\\n'),B=assemble().split('\\n');
    var hs=hunks(diffLines(A,B));
    diffBody.innerHTML=hs.length?(mode==='split'?renderSplit(hs,A,B):renderInline(hs,A,B)):'<p style="padding:14px">No changes.</p>';
    document.getElementById('dmInline').classList.toggle('on',mode==='inline');
    document.getElementById('dmSplit').classList.toggle('on',mode==='split');
    modal.hidden=false;
  }
  document.getElementById('btnDiff').addEventListener('click',showDiff);
  document.getElementById('dmInline').addEventListener('click',function(){mode='inline';showDiff();});
  document.getElementById('dmSplit').addEventListener('click',function(){mode='split';showDiff();});
  document.getElementById('dmClose').addEventListener('click',function(){modal.hidden=true;});
  modal.addEventListener('click',function(e){if(e.target===modal)modal.hidden=true;});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!modal.hidden)modal.hidden=true;});

  // ---- Save: two beats, one POST, one manual run ----
  // First Save arms the "for the record" line — every manual edit carries a
  // why, typed at the moment of saving. Enter (or Save again) commits; Escape
  // steps back to the buttons; an empty line refuses quietly, never alerts.
  var whyRow=document.getElementById('whyRow'),whyIn=document.getElementById('whyIn');
  function armWhy(){bar.classList.add('why');whyRow.hidden=false;whyIn.focus();}
  function disarmWhy(){bar.classList.remove('why');whyRow.hidden=true;whyIn.classList.remove('need');}
  function doSave(msg){
    var payload={
      baseHash:CFG.baseHash,
      message:msg,
      sections:dirtyUnits().map(function(u){return{idx:Number(u.dataset.idx),heading:u.dataset.heading,text:normSec(u.querySelector('.esrc').value)};}),
      fields:dirtyFlds().map(function(f){return{key:f.dataset.key,value:normFld(f.querySelector('.efield-input').value)};})
    };
    if(!payload.sections.length&&!payload.fields.length)return;
    var btns=[].slice.call(bar.querySelectorAll('.btn'));
    btns.forEach(function(b){b.disabled=true;});
    whyIn.disabled=true;
    fetch('/c/'+encodeURIComponent(CFG.slug)+'/edit',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},
      body:JSON.stringify(payload)
    }).then(function(r){return r.json().catch(function(){return{ok:false,error:'HTTP '+r.status};});})
      .then(function(d){
        if(d.ok)location.reload();
        else{alert(d.error||'save failed');btns.forEach(function(b){b.disabled=false;});whyIn.disabled=false;}
      }).catch(function(){alert('save failed — network error');btns.forEach(function(b){b.disabled=false;});whyIn.disabled=false;});
  }
  function trySave(){
    var msg=whyIn.value.replace(/\\s+/g,' ').trim();
    if(!msg){whyIn.classList.add('need');whyIn.focus();return;}
    doSave(msg);
  }
  document.getElementById('btnSave').addEventListener('click',function(){
    if(!dirtyUnits().length&&!dirtyFlds().length)return;
    if(bar.classList.contains('why'))trySave();
    else armWhy();
  });
  whyIn.addEventListener('input',function(){whyIn.classList.remove('need');});
  whyIn.addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();trySave();}
    else if(e.key==='Escape'){e.stopPropagation();disarmWhy();}
  });

  // Typing anywhere with pending edits should not be lost to a stray navigation.
  window.addEventListener('beforeunload',function(e){
    if(!bar.hidden&&!bar.querySelector('.btn').disabled){e.preventDefault();e.returnValue='';}
  });
})();</script>`;

// Nicknames: confirm ✓ · edit ✎ · dismiss ↺, plus the "+ nickname" hand-add.
// Event-delegated on the stable .phead-id host so a swapped-in .nn keeps working.
// Every mutation POSTs to /c/<slug>/nick/<action> and swaps the whole .nn block
// for the server's freshly-rendered one; a refusal restores the UI and shows a
// brief inline note. Dependency-free, same inline-edit vocabulary as the profile.
const NN_JS = `<script>(function(){
  var host=document.querySelector('.phead-id');if(!host)return;
  var SLUG=(window.__EDIT_CFG&&window.__EDIT_CFG.slug)||'';if(!SLUG)return;

  function post(action,payload){
    return fetch('/c/'+encodeURIComponent(SLUG)+'/nick/'+action,{
      method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},
      body:JSON.stringify(payload||{})
    }).then(function(r){return r.json().catch(function(){return{ok:false,error:'HTTP '+r.status};});});
  }
  // Swap the whole .nn block for the server's freshly-rendered one.
  function swap(html){var nn=host.querySelector('.nn');if(nn&&html!=null)nn.outerHTML=html;}
  // A brief inline note when the server refuses; replaces any prior note.
  function note(msg){
    var nn=host.querySelector('.nn');if(!nn)return;
    var n=nn.querySelector('.nn-note');
    if(!n){n=document.createElement('span');n.className='nn-note';nn.appendChild(n);}
    n.textContent=msg;
  }
  // Replace a node with a seeded textarea; Enter commits via commit(value,putBack),
  // Escape/blur restores the original node. commit calls putBack itself only when
  // the server refuses (a success swaps the whole block, removing the editor). The
  // editor keeps a fixed character width (so the layout never widens) and grows in
  // height as you type; while it is open the enclosing row's controls hide via the
  // 'editing' class — removed on putBack, and gone anyway on success when the block
  // is swapped. The add affordance (.nn-add) has no .nn-tag, hence the guard.
  function editField(anchor,seed,commit){
    var restore=anchor.outerHTML;
    var li=anchor.closest&&anchor.closest('.nn-tag');
    var inp=document.createElement('textarea');
    inp.className='nn-edit-input';inp.value=seed||'';inp.maxLength=40;inp.rows=1;
    inp.setAttribute('aria-label','nickname');
    if(li)li.classList.add('editing');
    anchor.replaceWith(inp);inp.focus();if(inp.select)inp.select();
    function grow(){inp.style.height='auto';inp.style.height=inp.scrollHeight+'px';}
    grow();
    var handled=false;
    function putBack(){if(li)li.classList.remove('editing');if(inp.parentNode)inp.outerHTML=restore;}
    inp.addEventListener('input',grow);
    inp.addEventListener('keydown',function(e){
      if(e.key==='Enter'){
        e.preventDefault();if(handled)return;handled=true;
        var v=inp.value.replace(/\\s+/g,' ').trim();
        if(!v){putBack();return;}
        commit(v,putBack);
      }else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(handled)return;handled=true;putBack();}
    });
    inp.addEventListener('blur',function(){if(handled)return;handled=true;putBack();});
  }

  host.addEventListener('click',function(e){
    var t=e.target;
    var add=t.closest&&t.closest('.nn-add');
    if(add){
      editField(add,'',function(v,putBack){
        post('add',{text:v}).then(function(d){if(d.ok)swap(d.html);else{putBack();note(d.error||'could not add');}})
          .catch(function(){putBack();note('network error');});
      });
      return;
    }
    var li=t.closest&&t.closest('.nn-tag');if(!li)return;
    var id=Number(li.getAttribute('data-nn-id'));
    if(t.closest('.nn-ok')){
      post('confirm',{id:id}).then(function(d){if(d.ok)swap(d.html);else note(d.error||'could not confirm');})
        .catch(function(){note('network error');});
    }else if(t.closest('.nn-del')){
      // A trash control with a two-click confirm. First click ARMS this button
      // (and disarms any other armed one); a second click within 2.5s deletes.
      // Clicks can land on the inner SVG, so resolve the button via closest.
      var del=t.closest('.nn-del');
      if(del.classList.contains('confirm')){
        post('dismiss',{id:id}).then(function(d){if(d.ok)swap(d.html);else note(d.error||'could not delete');})
          .catch(function(){note('network error');});
      }else{
        [].forEach.call(host.querySelectorAll('.nn-del.confirm'),function(b){b.classList.remove('confirm');if(b.dataset.t0!=null)b.title=b.dataset.t0;});
        del.dataset.t0=del.title;del.classList.add('confirm');del.title='click again to delete';
        setTimeout(function(){if(del.classList.contains('confirm')){del.classList.remove('confirm');del.title=del.dataset.t0||'delete';}},2500);
      }
    }else if(t.closest('.nn-edit')){
      var word=li.querySelector('.nn-word');if(!word)return;
      var cur=word.textContent;
      editField(word,cur,function(v,putBack){
        if(v===cur){putBack();return;}
        post('edit',{id:id,text:v}).then(function(d){if(d.ok)swap(d.html);else{putBack();note(d.error||'could not rename');}})
          .catch(function(){putBack();note('network error');});
      });
    }
  });
})();</script>`;

// NO RENAME. A contact's display name is auto-derived from their Signal nickname
// (lib/signal-names) and reconciled into the profile heading + crm.db on every
// pipeline run (crm-refresh.syncContactNames). To rename someone, set their
// nickname in the Signal app; it syncs here. The old /c/<slug>/rename form and its
// renameContact() writer were removed.

// ---- manual edit: apply a save from the profile page -------------------------
// One POST carries every dirty unit: `##` sections as replacement Markdown, and
// the two hand-owned header fields (Relationship, Birthday — Nathan's knowledge,
// not message-derivable; every other metadata line is pipeline-owned and stays
// read-only). A save is treated as a real pass: it refuses to run while a
// pipeline run holds the profile (a merge rewriting the same file would clobber
// the edit), commits to the isolated history, and lands in the runs ledger as
// kind 'manual' — one run per profile per save. `baseHash` is the sha256 of the
// file as the page rendered it: if anything rewrote the profile since, the save
// is refused rather than silently merged.
const EDITABLE_FIELDS = [
  ['relationship', 'Relationship'],
  ['birthday', 'Birthday'],
  ['phone', 'Phone'],
];

// Added/removed line counts for a section edit's step label. A multiset diff,
// not an LCS: close enough for a summary, and O(n).
function lineDelta(oldText, newText) {
  const count = new Map();
  for (const l of oldText.split('\n')) count.set(l, (count.get(l) || 0) + 1);
  let added = 0;
  for (const l of newText.split('\n')) {
    const c = count.get(l) || 0;
    if (c > 0) count.set(l, c - 1);
    else added += 1;
  }
  let removed = 0;
  for (const c of count.values()) removed += c;
  return { added, removed };
}

function applyManualEdit(slug, payload) {
  const file = path.posix.join(CONTACTS_DIR, `${slug}.md`);
  let md;
  try { md = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, status: 404, error: 'no such contact' }; }
  // The file lock alone is not enough here: while THIS process runs a web job it
  // holds the lock itself, so acquire() would hand back an inherited no-op and
  // let the edit race the job's merges. Check the in-memory job first.
  if (job && job.running) return { ok: false, status: 409, error: 'a job is running — save again when it finishes' };
  const lock = require('../lib/pipeline-lock').acquire('manual-edit');
  if (!lock.ok) return { ok: false, status: 409, error: `a run is in progress (${lock.holderDesc}) — save again when it finishes` };
  const startedAt = Date.now();
  try {
    const hash = crypto.createHash('sha256').update(md).digest('hex');
    if (payload.baseHash !== hash) {
      return { ok: false, status: 409, error: 'the profile changed since this page loaded — reload and re-apply your edits' };
    }
    const { lines, units } = splitProfile(md);

    // Units splice bottom-up so earlier spans stay valid; each replacement is
    // followed by the one blank line that separates blocks. An empty text
    // deletes the unit outright. MIRRORS assemble() in PROFILE_EDIT_JS.
    const secChanges = [];
    const secEdits = (Array.isArray(payload.sections) ? payload.sections : [])
      .filter((e) => Number.isInteger(e.idx) && units[e.idx] && typeof e.text === 'string')
      .sort((a, b) => b.idx - a.idx);
    for (const e of secEdits) {
      const span = units[e.idx];
      if (String(e.heading || '') !== span.heading) {
        return { ok: false, status: 409, error: 'section layout changed — reload and re-apply your edits' };
      }
      const text = String(e.text).replace(/\r/g, '').replace(/^\n+/, '').replace(/\n+$/, '');
      if (text.length > 200_000) return { ok: false, status: 400, error: `section "${span.heading}" too large` };
      const oldText = sectionText(lines, span);
      if (text === oldText) continue;
      lines.splice(span.from, span.to - span.from, ...(text === '' ? [] : [...text.split('\n'), '']));
      secChanges.push({ section: span.heading, level: span.level, ...lineDelta(oldText, text) });
    }
    secChanges.reverse(); // back into file order for the run record

    // Fields rewrite (or insert into) the header block only — a `- **X:**` line
    // in an old-shape What-I-know bullet must never match.
    const byKey = new Map(EDITABLE_FIELDS);
    const fieldChanges = [];
    for (const f of (Array.isArray(payload.fields) ? payload.fields : [])) {
      const label = byKey.get(f && f.key);
      if (!label) continue;
      const value = String(f.value == null ? '' : f.value).replace(/[\r\n]+/g, ' ').trim().slice(0, 120) || '_TBD_';
      let headerEnd = lines.findIndex((l) => /^## /.test(l));
      if (headerEnd === -1) headerEnd = lines.length;
      const re = new RegExp(`^- \\*\\*${label}:\\*\\* (.*)$`);
      let idx = -1;
      let cur = null;
      for (let i = 0; i < headerEnd; i += 1) {
        const m = lines[i].match(re);
        if (m) { idx = i; cur = m[1].trim(); break; }
      }
      if (cur === value || (cur == null && value === '_TBD_')) continue;
      if (idx !== -1) lines[idx] = `- **${label}:** ${value}`;
      else {
        // A metadata line the profile lacks is added at the end of the block:
        // after the last `- ` bullet that follows the `# ` title.
        let i = lines.findIndex((l) => l.startsWith('# ')) + 1;
        while (i < headerEnd && (lines[i].trim() === '' || lines[i].startsWith('- '))) i += 1;
        while (i > 0 && lines[i - 1].trim() === '') i -= 1;
        lines.splice(i, 0, `- **${label}:** ${value}`);
      }
      fieldChanges.push({ key: f.key, field: label, from: cur == null ? '(absent)' : cur, to: value });
    }

    if (!fieldChanges.length && !secChanges.length) return { ok: true, changed: 0 };
    // Nathan's "why" — the commit message for this set of edits. Subject stays
    // machine-shaped; his context rides as the body, and both land in the run
    // record so the provenance view can show them without a git subprocess.
    const message = String(payload.message || '').replace(/\r/g, '').trim().slice(0, 500);
    let out = lines.join('\n');
    if (!out.endsWith('\n')) out += '\n';
    fs.writeFileSync(file, out);
    // Hand-owned Person fields write through to the structured store in the same
    // save. A cleared/TBD value retracts the current fact; a real value becomes a
    // provenance-free manual standing fact. Roll the file back if this write fails.
    if (fieldChanges.length) {
      let personDb = null;
      try {
        personDb = openCrmDb();
        personDb.exec('BEGIN IMMEDIATE');
        for (const f of fieldChanges) {
          if (f.to === '_TBD_') retractCurrentFact(personDb, slug, f.key, startedAt);
          else recordFact(personDb, {
            slug, field: f.key, kind: 'standing', value: f.to, src_msg: null,
            observed_at: startedAt, run_id: null,
          });
        }
        personDb.exec('COMMIT');
      } catch (e) {
        if (personDb) { try { personDb.exec('ROLLBACK'); } catch { /* original wins */ } }
        try { fs.writeFileSync(file, md); } catch { /* surfaced below */ }
        return { ok: false, status: 500, error: `structured person write failed; profile restored: ${e.message}` };
      } finally { if (personDb) try { personDb.close(); } catch { /* closed */ } }
    }
    // Same isolated-history commit as a rename, so the edit shows on the
    // profile's history page with a clean attribution. pre/post shas make the
    // run's line-level diff viewable at /runs/<id>/diff/<slug>.
    const relPath = `data/contacts/${slug}.md`;
    const rev = () => {
      try {
        return execFileSync('git', ['--git-dir', GITDIR, 'rev-parse', 'HEAD'],
          { cwd: ROOT, encoding: 'utf8', timeout: 15_000 }).trim();
      } catch { return null; }
    };
    const preSha = rev();
    let postSha = null;
    const names = [...fieldChanges.map((c) => c.field), ...secChanges.map((c) => c.section)];
    try {
      // -f: data/ is ignored by the MAIN repo's .gitignore, which this shared
      // work-tree applies — a bare `add` refuses the path.
      execFileSync('git', ['--git-dir', GITDIR, '--work-tree', ROOT, 'add', '-f', '--', relPath], { cwd: ROOT, timeout: 15_000 });
      const subject = `manual edit ${slug}: ${names.join(', ')}`;
      execFileSync('git', ['--git-dir', GITDIR, '--work-tree', ROOT, 'commit', '-m',
        message ? `${subject}\n\n${message}` : subject], { cwd: ROOT, timeout: 15_000 });
      postSha = rev();
    } catch { /* uncommitted edit still shows */ }
    // One ledger row per save, grouped by profile (`only: slug`). Non-fatal: a
    // missing ledger row must never fail the edit that produced it.
    const endedAt = Date.now();
    try {
      require('../lib/run-record').writeRunRecord({
        kind: 'manual',
        startedAt, endedAt, durationMs: endedAt - startedAt,
        only: slug,
        message: message || undefined,
        preSha: preSha || undefined,
        postSha: postSha || undefined,
        fields: fieldChanges,
        sections: secChanges,
        steps: [
          ...fieldChanges.map((c) => ({ name: `${c.field}: ${c.from} → ${c.to}`, ok: true, ms: 0 })),
          ...secChanges.map((c) => ({ name: `${'#'.repeat(c.level || 2)} ${c.section}: +${c.added} −${c.removed} line(s)`, ok: true, ms: 0 })),
        ],
      });
    } catch { /* edit already applied */ }
    return { ok: true, changed: fieldChanges.length + secChanges.length };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Screen B — /status: what would run right now, per tracked contact
// ---------------------------------------------------------------------------
function loadTrackedSlugs() {
  try { return JSON.parse(fs.readFileSync(TRACKED, 'utf8')).slugs || []; } catch { return []; }
}
function loadRuns() {
  let files = [];
  try { files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  files.sort().reverse(); // ISO-ish names: lexical desc == newest first
  const runs = [];
  for (const f of files) {
    try { runs.push(JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'))); } catch { /* skip corrupt */ }
  }
  return runs;
}
function runMode(run) {
  if (run.dryRun) return 'dry-run';
  if (run.only) return `only ${run.only}`;
  return 'full';
}
function fmtMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 90_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
// Runs-ledger timestamp, in PACIFIC (the timezone everything else in this repo
// prints — see lib/weeks). Recent runs read "today 14:32" / "yesterday 09:15" /
// "3 days ago 18:40"; past a week it falls back to the plain Pacific date.
function pacDayIndex(dstr) {
  const [y, m, d] = dstr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function fmtWhen(ts) {
  const local = ptLocal(ts);       // "YYYY-MM-DD HH:MM" in Pacific
  const hm = local.slice(11);
  const dkey = local.slice(0, 10);
  const diff = pacDayIndex(ptDateKey(Date.now())) - pacDayIndex(dkey);
  let label;
  if (diff <= 0) label = 'today';
  else if (diff === 1) label = 'yesterday';
  else if (diff <= 7) label = `${diff} days ago`;
  else label = dkey;
  return `${label} ${hm}`;
}

function fmtAgo(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  if (m < 60 * 48) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / (60 * 24))}d`;
}

function loadArchiveState() {
  try { return JSON.parse(fs.readFileSync(ARCHIVE_STATE_FILE, 'utf8')); } catch { return {}; }
}

function backupAgeMs(now) {
  const dir = 'C:/Users/natha/Programming/personal-crm-backups';
  try {
    const dbs = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
    if (!dbs.length) return null;
    return now - Math.max(...dbs.map((f) => fs.statSync(path.posix.join(dir, f)).mtimeMs));
  } catch { return null; }
}

function dial(label, cadence, sinceMs, intervalMs, job, sched) {
  // `job` is the kind the dial's own trigger button submits. `sched`, when given,
  // is the REAL cron ({ prevFire, nextFire } in ms): the countdown targets the next
  // scheduled fire (e.g. next Monday 04:00), NOT `interval - sinceMs`. The old
  // rolling model counted a full interval from the LAST run — so a manual run reset
  // it and a weekly job wrongly showed ~7 days instead of "til next Monday".
  const now = Date.now();
  const since = sinceMs == null ? 'not yet run' : `${fmtAgo(sinceMs)} ago`;
  // The dial's job ink (deep sweep is a sweep) — keys the shared --k-* colours.
  const kind = job === 'deep-sweep' ? 'sweep' : job;
  if (sched) {
    const remaining = Math.max(0, sched.nextFire - now);
    const fraction = (now - sched.prevFire) / (sched.nextFire - sched.prevFire);
    // Stale (red) = a full period-and-a-half elapsed since the last actual run, so
    // the schedule may have stopped. A manual run legitimately resets this.
    const stale = sinceMs != null && sinceMs > intervalMs * 1.5;
    return {
      label, cadence, job, kind, since,
      center: fmtAgo(remaining), centerSub: 'til next',
      fraction: Math.max(0, Math.min(1, fraction)), overdue: stale,
    };
  }
  // Fallback rolling model (dials with no fixed schedule).
  if (sinceMs == null) {
    return { label, cadence, job, kind, since: 'not yet run', center: '—', centerSub: 'never', fraction: 0, overdue: false };
  }
  const remaining = intervalMs - sinceMs;
  const overdue = remaining < 0;
  return {
    label, cadence, job, kind, since,
    center: overdue ? `+${fmtAgo(-remaining)}` : fmtAgo(remaining),
    centerSub: overdue ? 'overdue' : 'til next',
    fraction: sinceMs / intervalMs, overdue,
  };
}

// Estimated cost of ingesting each contact's WAITING messages, for the confirm
// modal. One lightweight query per waiting contact (timestamps + body lengths
// only, never the bodies), bucketed into active weeks = merge calls. Cost is
// call-count-dominated (see lib/cost.js), so this is a real estimate, not a
// guess — but an estimate all the same. Attaches { estCalls, estCostUsd } to
// each roster row; estCostUsd is null when the model has no known price.
//
// Cached per contact: recomputing pulled every waiting row on every /admin
// load — seconds once a few backfills are pending. The estimate only moves when a
// sweep or merge lands, i.e. when `waiting` moves, so that is the cache key.
const pendingCostCache = new Map(); // slug -> { waiting, est }
function attachPendingCosts(roster) {
  const waiting = roster.filter((x) => x.waiting > 0);
  const stale = waiting.filter((x) => {
    const c = pendingCostCache.get(x.slug);
    return !c || c.waiting !== x.waiting;
  });
  if (stale.length) {
    const cdb = openCrmDb();
    try {
      const q = cdb.prepare('SELECT sent_at, length(body) AS blen FROM messages WHERE contact_slug = ? AND id NOT IN (SELECT message_id FROM merged WHERE slug = ?) ORDER BY sent_at');
      for (const x of stale) {
        const rows = q.all(x.slug, x.slug);
        pendingCostCache.set(x.slug, { waiting: x.waiting, est: estIngestFromRows(MERGE_MODEL, TIMELINE_MODEL, rows) });
      }
    } finally {
      cdb.close();
    }
  }
  for (const x of waiting) {
    const est = pendingCostCache.get(x.slug).est;
    x.estCalls = est.calls;
    x.estCostUsd = est.usd; // dollars, 0 for subscription models, null if unpriced
    x.estDurSec = est.seconds; // wall-clock estimate (merges run sequentially)
  }
  return roster;
}

function adminData() {
  const now = Date.now();
  const roster = attachPendingCosts(contactList());
  let kept = 0;
  let span = '—';
  const cdb = openCrmDb();
  try {
    const r = cdb.prepare('SELECT COUNT(*) n, MIN(sent_at) a, MAX(sent_at) b FROM messages').get();
    kept = r.n || 0;
    if (r.a) span = `${ptDateKey(r.a)} → ${ptDateKey(r.b)}`;
  } finally {
    cdb.close();
  }
  const arch = loadArchiveState();
  const sweepMs = arch.ranAt ? now - arch.ranAt : null;
  const deepMs = arch.deepRanAt ? now - arch.deepRanAt : null;
  const runs = loadRuns();
  // Time since the last run OF THAT KIND — runs[] now holds sweep/todo records
  // too, so runs[0] is no longer necessarily an ingest.
  const lastRunMs = (k) => { const r = runs.find((x) => (x.kind || 'ingest') === k); return r ? now - r.startedAt : null; };
  const ingestMs = lastRunMs('ingest');
  const todoMs = lastRunMs('todo');
  const backupMs = backupAgeMs(now);
  const waiting = roster.reduce((s, x) => s + x.waiting, 0);
  const inPeople = roster.filter((x) => x.waiting > 0).length;
  const heldReview = roster.filter((x) => x.heldReview).length;
  const HOUR = 3600000;
  const health = {
    kept: kept.toLocaleString(), span, tracked: roster.length,
    stranded: '—', strandedSub: 'deep-sweep to verify',
    lastSweep: sweepMs == null ? '—' : fmtAgo(sweepMs), lastSweepSub: sweepMs == null ? 'never run' : 'ago · hourly',
    sweepStale: sweepMs != null && sweepMs > 90 * 60000,
    waiting: waiting.toLocaleString(), waitingSub: `in ${inPeople} ${inPeople === 1 ? 'person' : 'people'}`,
    backupAge: backupMs == null ? '—' : fmtAgo(backupMs), backupSub: 'off-machine', backupStale: backupMs != null && backupMs > 8 * DAY,
    heldReview,
  };
  // A dial per scheduled job, named to match the Key — no vague "pipeline". Each
  // maps to a real registered task (tools/register-*.ps1): sweep is the hourly
  // archive copy; the deep sweep is a daily full re-walk; ingest is the weekly
  // Monday run (its merge + Timeline halves share one clock); todo is hourly.
  // Real cron schedules (tools/register-*.ps1): archive sweep + todo at the top of
  // every hour; deep sweep daily 03:00 Pacific; the weekly AI run Monday 04:00
  // Pacific. Each dial counts down to its NEXT fire, not a rolling interval.
  const nextHour = Math.ceil(now / HOUR) * HOUR;
  const nextDeep = nextPacificDaily(3, 0, now);
  const prevMon = weekStart(now);
  const nextMon = nextWeekStart(prevMon);
  // Dial LABELS come from lib/jobs.js (the single source of truth for the job set
  // and its names); the SCHEDULE (cadence text + fire times) is dashboard-owned,
  // since lib/jobs.js deliberately holds no cron. One dial per job id, in flow order.
  const L = JOBS_DEF.labelFor;
  const dials = [
    dial(L('sweep'), 'hourly', sweepMs, HOUR, 'sweep', { prevFire: nextHour - HOUR, nextFire: nextHour }),
    dial(L('deep-sweep'), 'daily · 3am', deepMs, DAY, 'deep-sweep', { prevFire: nextDeep - DAY, nextFire: nextDeep }),
    dial(L('ingest'), 'weekly · Mon 4am', ingestMs, 7 * DAY, 'ingest', { prevFire: prevMon, nextFire: nextMon }),
    dial(L('todo'), 'hourly · after sweep', todoMs, HOUR, 'todo', { prevFire: nextHour - HOUR, nextFire: nextHour }),
  ];
  // The model each job falls back to when no override is stored — so the picker can
  // show the real effective model instead of a "default" placeholder. One source of
  // truth (JOB_DEFAULT_MODEL), shared with the client DEF map in JOB_MODAL_JS.
  return { health, roster, dials, toggles: RUN_TOGGLES.getToggles(), models: RUN_MODELS.getModels(), modelOptions: RUN_MODELS.MODELS, modelDefaults: JOB_DEFAULT_MODEL };
}

// The single source of truth for each model-job's DEFAULT model (used when no UI
// override is stored). Both the server-rendered picker (adminData.modelDefaults) and
// the client cost estimator (DEF, below) derive from this one map — X3-10.
const JOB_DEFAULT_MODEL = { ingest: MERGE_MODEL, todo: 'moonshotai/kimi-k3' };

// Confirm modal for the job buttons. Replaces the browser confirm() with a
// Bindery slip that resolves and LISTS the exact people the run will touch:
// the checked roster names, or everyone if none are checked, or the single
// person for a row's own trigger. Approving submits the form with that button.
const JOB_MODAL_JS = `<script>(function(){
  var form=document.querySelector('form[action="/admin/jobs"]');
  if(!form)return;
  // The effective model per job, read LIVE from the card's <select> (so a just-
  // changed selection is reflected without a server restart), falling back to the
  // pipeline default when "default" is chosen. free = anthropic/* (subscription),
  // matching lib/cost isFree. ingest's model governs merge AND Timeline.
  var DEF=${JSON.stringify(JOB_DEFAULT_MODEL)};
  function modelFor(kind){
    var sel=form.querySelector('select[name="model:'+kind+'"]');
    var id=(sel&&sel.value)||DEF[kind]||'';
    return {label:id?id.split('/').pop():'?',free:id.indexOf('anthropic/')===0};
  }
  function fmtUsd(v){if(!(v>0))return '$0';if(v<0.01)return '<$0.01';if(v<10)return '$'+v.toFixed(2);if(v<100)return '$'+v.toFixed(1);return '$'+Math.round(v);}
  function fmtDur(sec){sec=Math.round(sec);if(!(sec>0))return '~0s';if(sec<90)return '~'+sec+'s';var m=Math.round(sec/60);if(m<60)return '~'+m+'m';return '~'+Math.floor(m/60)+'h '+(m%60)+'m';}
  var ov=document.createElement('div');ov.className='modal';ov.hidden=true;
  ov.innerHTML='<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="mTitle">'
    +'<div class="modal-stamp" id="mStamp"></div>'
    +'<h2 class="modal-title" id="mTitle"></h2>'
    +'<div class="modal-meta" id="mMeta"></div>'
    +'<div class="modal-cost" id="mCost"></div>'
    +'<div class="modal-whoh" id="mWhoH"></div>'
    +'<ul class="modal-who" id="mWho"></ul>'
    +'<div class="modal-acts"><button type="button" class="btn" data-x="cancel">Cancel</button>'
    +'<button type="button" class="btn pr" data-x="run">Run</button></div></div>';
  document.body.appendChild(ov);
  var pending=null;
  function boxes(){return Array.prototype.slice.call(form.querySelectorAll('.pick'));}
  function nameFor(slug){
    var el=form.querySelector('.pick[value="'+slug+'"]');
    if(!el)return slug;
    var row=el.closest('tr'),a=row&&row.querySelector('.person a');
    return a?a.textContent.trim():slug;
  }
  function modOn(name){var el=form.querySelector('input[name='+name+']');return !!(el&&el.checked);}
  // Estimate line for the run about to happen. Sweeps are free; todo only spends
  // on a match; ingest sums the per-person data-cost of the boxes being run.
  function costLine(kind,isSweep,runBoxes){
    var el=document.getElementById('mCost');
    if(isSweep){el.textContent='Est. — no model call · seconds';return;}
    if(kind==='todo'){var tm=modelFor('todo');el.textContent='Est. — no model call unless a "make sure"/"eod" line matches · '+tm.label;return;}
    var mj=modelFor(kind);
    var sum=0,calls=0,dur=0,unknown=false;
    runBoxes.forEach(function(c){
      var d=c.getAttribute('data-cost'),k=parseInt(c.getAttribute('data-calls')||'0',10);
      dur+=parseInt(c.getAttribute('data-dur')||'0',10);
      calls+=k;
      if(d===''||d==null){if(k>0)unknown=true;}else{sum+=parseFloat(d);}
    });
    var money=mj.free?('on plan · '+mj.label):((unknown?'—':fmtUsd(sum))+' · '+mj.label);
    el.textContent='Est. '+money+'  ·  '+fmtDur(dur)+'  ·  '+calls+(calls===1?' week':' weeks');
  }
  function open(btn){
    pending=btn;
    var val=btn.value,i=val.indexOf(':');
    var kind=i===-1?val:val.slice(0,i),one=i===-1?null:val.slice(i+1);
    var isSweep=kind==='sweep'||kind==='deep-sweep';
    var everyone=false,runBoxes;
    if(one){runBoxes=boxes().filter(function(c){return c.value===one;});}
    else if(kind==='todo'){everyone=true;runBoxes=boxes();}
    else{
      var checked=boxes().filter(function(c){return c.checked;});
      if(checked.length){runBoxes=checked;}
      else{everyone=true;runBoxes=boxes();}
    }
    var who=runBoxes.map(function(c){return nameFor(c.value);});
    var kindLabel=kind==='deep-sweep'?'deep sweep':kind;
    var st=document.getElementById('mStamp');
    st.textContent=kindLabel;
    st.className='modal-stamp '+(isSweep?'sweep':kind);
    document.getElementById('mTitle').textContent='Run '+kindLabel;
    document.getElementById('mMeta').textContent=isSweep?'No model — copies messages into the archive.':(kind==='todo'?'Scans for "make sure"/"eod" commitments; a model runs only on a match.':'Calls the model — ingest, then Timeline.');
    costLine(kind,isSweep,runBoxes);
    document.getElementById('mWhoH').textContent=(kind==='todo'?'Whole archive — ':(everyone?'Everyone — ':''))+'will run on '+who.length+(who.length===1?' person':' people');
    var ul=document.getElementById('mWho');ul.innerHTML='';
    who.forEach(function(nm){var li=document.createElement('li');li.textContent=nm;ul.appendChild(li);});
    ov.hidden=false;document.querySelector('[data-x=run]').focus();
  }
  function close(){ov.hidden=true;pending=null;}
  form.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('button[name=job]');
    if(!b)return;e.preventDefault();open(b);
  });
  ov.addEventListener('click',function(e){
    if(e.target===ov){close();return;}
    var x=e.target.closest&&e.target.closest('[data-x]');
    if(!x)return;
    if(x.getAttribute('data-x')==='cancel'){close();return;}
    var b=pending;close();if(b)form.requestSubmit(b);
  });
  document.addEventListener('keydown',function(e){if(!ov.hidden&&e.key==='Escape')close();});
})();</script>`;

function statusPage() {
  return page('Pipeline — personal-crm', render(V.admin(adminData()).body) + JOB_MODAL_JS);
}

// ---------------------------------------------------------------------------
// Screen A — /runs, /runs/<id>, /runs/<id>/diff/<slug>
// ---------------------------------------------------------------------------
// One ledger row per run record. `kind` drives the row's colour (sweep/ingest/
// timeline each get a distinct chip) and which fields fill the shared columns —
// the numbers mean different things per kind, but the header labels stay generic
// and the note clarifies. `ok:false` renders the note in oxblood.
function rowForRun(r) {
  const t = fmtWhen(r.startedAt);
  const took = fmtMs(r.durationMs);
  if (r.kind === 'sweep') {
    return {
      t, kind: 'sweep', kindWord: r.deep ? 'deep' : 'sweep',
      pass: r.deep ? 'deep' : 'hourly',
      scope: r.only || 'everyone',
      examined: String(r.seen ?? ''),
      held: `${r.inserted ?? 0} new`,
      cost: 'free', actual: 'free', took, ok: true,
      note: r.reuse ? 'rowid reuse detected' : `${r.inserted ?? 0} message(s) archived`,
    };
  }
  // 'timeline' is the current kind; 'compact' is the pre-rename spelling still
  // present in older run records, normalized to the same row here.
  if (r.kind === 'timeline' || r.kind === 'compact') {
    return {
      t, kind: 'timeline',
      pass: r.only ? 'timeline (one)' : 'timeline',
      scope: r.only || 'everyone',
      examined: String(r.scanned ?? ''),
      held: `${r.changed ?? 0} changed`,
      cost: costCell(r), actual: actualCell(r), took, ok: true,
      note: `${r.summaries ?? 0} summary line(s)`,
    };
  }
  if (r.kind === 'todo') {
    return {
      t, kind: 'todo',
      pass: 'scan',
      scope: 'everyone',
      examined: String(r.scanned ?? ''),
      held: `${r.inserted ?? 0} task(s)`,
      cost: r.triggers ? costCell(r) : 'free', actual: r.triggers ? actualCell(r) : 'free', took, ok: true,
      note: r.triggers ? `${r.triggers} trigger(s)` : 'no triggers',
    };
  }
  if (r.kind === 'manual') {
    const units = [...(r.fields || []).map((f) => f.field), ...(r.sections || []).map((s) => s.section)];
    return {
      t, kind: 'manual',
      pass: 'edit',
      scope: r.only || '',
      examined: '',
      held: `${units.length} change(s)`,
      cost: 'free', actual: 'free', took, ok: true,
      // The "why" he typed is the most useful cell; fall back to what changed.
      note: r.message || (units.length ? units.join(', ') : 'no changes'),
    };
  }
  // ingest (also the default for legacy records written before `kind` existed)
  const failures = (r.mergeFailures || []).length;
  return {
    t, kind: 'ingest',
    pass: r.dryRun ? 'plan' : (r.only ? 'ingest (one)' : 'daily'),
    scope: r.only || 'everyone',
    examined: String(r.messagesMerged ?? r.contactsWithActivity ?? ''),
    held: `${(r.merged || []).length} ppl`,
    cost: r.dryRun ? 'free' : costCell(r), actual: r.dryRun ? 'free' : actualCell(r), took, ok: failures === 0,
    note: failures
      ? `${failures} merge failure(s)`
      : ((r.warnings || []).length ? `${r.warnings.length} warning(s)` : `${r.chunksMerged ?? 0} chunk(s) ingested`),
  };
}

// The ESTIMATED-cost cell for a model-calling run. Records written before cost
// tracking have no costUsd field (undefined) → "—"; a subscription model is free.
function costCell(r) {
  if (r.costUsd === undefined && r.costModel === undefined) return '—';
  if (isFree(r.costModel)) return fmtUsd(0, { free: true });
  return fmtUsd(r.costUsd == null ? null : r.costUsd);
}

// The ACTUAL-cost cell, summed from pi's real session usage after the run.
// Subscription models are $0; anything not captured (legacy rows, capture
// failed, todo) reads "—".
function actualCell(r) {
  if (isFree(r.costModel)) return fmtUsd(0, { free: true });
  return fmtUsd(r.actualCostUsd == null ? null : r.actualCostUsd);
}

// The in-flight job as a ledger row, so a run shows up the moment it starts —
// clickable through to the live monitor. Progress/ETA come from the streamed log.
function liveJobRow() {
  if (!job || !job.running) return null;
  const elapsedMs = Date.now() - job.startedAt;
  const prog = parseJobProgress(job.buf, elapsedMs);
  const kind = job.kind === 'deep-sweep' ? 'sweep' : job.kind;
  let pass;
  let held;
  let took;
  if (prog) {
    pass = prog.phase === 'timeline' ? 'building timeline' : `chunk ${prog.done}/${prog.total}`;
    held = prog.phase === 'ingest' ? `${prog.pct}%` : '···';
    took = fmtMs(elapsedMs) + (prog.etaMs != null ? ` · ~${fmtMs(prog.etaMs)} left` : '');
  } else {
    pass = 'starting…'; held = ''; took = fmtMs(elapsedMs);
  }
  return {
    live: true, href: '/admin/jobs/current',
    t: 'now', kind, pass, scope: job.scope,
    examined: '', held, cost: '', actual: '', took, ok: true,
    note: 'monitor live →',
  };
}

function runsPage() {
  // Normalize kind on read: null → 'ingest' (legacy records predate `kind`), and
  // the pre-rename 'compact' → 'timeline' — else an old compact record buckets as
  // its own kind and is pinned forever as a second, frozen heartbeat row.
  const all = loadRuns().map((r) => ({ ...r, kind: r.kind === 'compact' ? 'timeline' : (r.kind || 'ingest') }));
  // The MOST RECENT run of each cadence kind always shows — so every scheduled
  // job (sweep, deep-sweep, ingest, todo) is visibly represented in the ledger as
  // a heartbeat, even when its latest tick did nothing. `crm-archive --deep`
  // records kind 'sweep', so a deep sweep counts as the sweep heartbeat.
  const latestOfKind = new Map();
  for (const r of all) {
    const k = r.kind;
    const prev = latestOfKind.get(k);
    if (!prev || (r.startedAt || 0) > (prev.startedAt || 0)) latestOfKind.set(k, r);
  }
  const latestIds = new Set([...latestOfKind.values()].map((r) => r.id));
  const records = all
    // Older no-op hourly ticks are hidden so they don't bury the runs that
    // mattered — but a run is kept if it did something OR it is the latest of its
    // kind (the heartbeat, above). Everything with any effect always shows.
    .filter((r) => {
      if (latestIds.has(r.id)) return true;
      if (r.kind === 'sweep' && !r.inserted) return false;
      if (r.kind === 'todo' && !r.triggers && !r.inserted) return false;
      return true;
    })
    // Each completed row links to its own detail page (steps, chunks, and log).
    .map((r) => { const row = rowForRun(r); row.href = r.id ? `/runs/${r.id}` : null; return row; });
  const live = liveJobRow();
  const rows = live ? [live, ...records] : records;
  // Keep the ledger fresh while something runs: the live row updates and turns
  // into a completed row on its own once the run lands its record.
  const refresh = job && job.running ? '<script>setTimeout(function(){location.reload();},5000);</script>' : '';
  return page('Runs — personal-crm', render(V.runs(rows).body) + RUNS_FILTER_JS + refresh);
}

// Client-side filtering for the runs ledger: kind chips (click to hide a kind)
// and a "hide free runs" checkbox, both remembered in localStorage. Rows carry
// data-kind / data-free (see RunRow); a live (running) row is never hidden.
const RUNS_FILTER_JS = `<script>(function(){
  var tb=document.querySelector('.ledger table tbody'); if(!tb)return;
  var chips=Array.prototype.slice.call(document.querySelectorAll('.rfchip'));
  var free=document.getElementById('rfHideFree');
  function load(k,d){try{var v=localStorage.getItem(k);return v==null?d:JSON.parse(v);}catch(e){return d;}}
  function save(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
  var offKinds=load('crm.runkinds',[]);
  chips.forEach(function(c){ if(offKinds.indexOf(c.getAttribute('data-k'))!==-1){c.classList.remove('on');c.classList.add('off');} });
  if(free)free.checked=!!load('crm.runsHideFree',false);
  function apply(){
    var off={}; chips.forEach(function(c){ if(!c.classList.contains('on'))off[c.getAttribute('data-k')]=1; });
    var hf=free&&free.checked;
    Array.prototype.slice.call(tb.querySelectorAll('tr.runrow')).forEach(function(tr){
      if(tr.classList.contains('live')){tr.hidden=false;return;}
      var k=tr.getAttribute('data-kind'), isFree=tr.getAttribute('data-free')==='1';
      tr.hidden = !!off[k] || (hf&&isFree);
    });
  }
  chips.forEach(function(c){ c.addEventListener('click',function(){
    c.classList.toggle('on'); c.classList.toggle('off');
    save('crm.runkinds', chips.filter(function(x){return !x.classList.contains('on');}).map(function(x){return x.getAttribute('data-k');}));
    apply();
  }); });
  if(free)free.addEventListener('change',function(){ save('crm.runsHideFree',free.checked); apply(); });
  apply();
})();</script>`;

function runDetailPage(id) {
  let run;
  try { run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${id}.json`), 'utf8')); } catch { return null; }

  const stepsHtml = (run.steps || []).map((s) => {
    const status = s.skipped ? '<span class="skip">skipped</span>' : (s.ok ? '<span class="ok">ok</span>' : '<span class="bad">FAILED</span>');
    const note = (s.note || '').trim();
    return `<details class="step"${s.ok === false ? ' open' : ''}><summary><span class="nm">${esc(s.name)}</span>${status}<span class="ms">${fmtMs(s.ms)}</span></summary>` +
      (note ? `<pre class="log">${esc(note)}</pre>` : '<p class="sub">no output</p>') + `</details>`;
  }).join('');

  // Runs are recorded per CHUNK (one week-aligned slice of one contact = one
  // merge = one commit). `run.contacts` is the pre-chunking shape, kept so old
  // run records still render.
  const rows = run.chunks || run.contacts || [];
  const chunked = Boolean(run.chunks);
  const contactsHtml = rows.length
    ? `<h2>${chunked ? 'Chunks' : 'Contacts'}</h2><table class="tbl"><tr><th>Contact</th>` +
      (chunked ? '<th>Window</th><th>#</th>' : '') +
      `<th>Msgs</th><th>Cursor</th><th>Merge</th><th>Citations</th><th>Changes</th></tr>` +
      rows.map((c, idx) => {
        const cite = c.citations
          ? (c.citations.missing.length ? `<span class="bad">${c.citations.missing.length}/${c.citations.cited} missing</span>` : `<span class="ok">${c.citations.cited} ok</span>`)
          : '<span class="skip">—</span>';
        // Per-chunk shas when present, else the whole-run pair (old records).
        const pre = c.preSha || run.preSha;
        const post = c.postSha || run.postSha;
        const canDiff = pre && post && pre !== post;
        const diffHref = `/runs/${encodeURIComponent(run.id)}/diff/${encodeURIComponent(c.slug)}` +
          (chunked ? `?chunk=${idx}` : '');
        return `<tr><td><a href="/c/${encodeURIComponent(c.slug)}">${esc(c.name || c.slug)}</a></td>` +
          (chunked
            ? `<td class="sub">${esc(c.label || '')}${c.partial ? ' <span class="skip">[day-split]</span>' : ''}</td>` +
              `<td class="num sub">${c.chunkIndex}/${c.chunkTotal}</td>`
            : '') +
          `<td class="num">${c.count}</td>` +
          `<td class="num">${c.cursorBefore == null ? 'backfill' : c.cursorBefore} → ${c.cursorAfter == null ? '—' : c.cursorAfter}</td>` +
          `<td>${c.ok ? `<span class="ok">ok</span> <span class="sub">${fmtMs(c.ms)}</span>` : `<span class="bad">FAILED</span> <span class="sub">${esc(String(c.error || '').slice(0, 200))}</span>`}</td>` +
          `<td>${cite}</td>` +
          `<td>${c.ok && canDiff ? `<a href="${diffHref}">diff</a>` : '<span class="skip">—</span>'}</td></tr>`;
      }).join('') + `</table>`
    : '<p class="sub">No contacts had new activity.</p>';

  // Manual-edit provenance: the "why" Nathan typed at save time, and a link to
  // the exact lines the edit changed (pre/post shas around its history commit).
  const manualHtml = run.kind === 'manual'
    ? (run.message ? `<h2>Why</h2><p>${esc(run.message)}</p>` : '') +
      (run.preSha && run.postSha && run.only
        ? `<h2>Changes</h2><p><a href="/runs/${encodeURIComponent(run.id)}/diff/${encodeURIComponent(run.only)}">line diff of ${esc(run.only)} &rarr;</a></p>`
        : '')
    : '';

  // Todo runs have no profile to diff — their equivalent is the DRAFTS they
  // captured, rendered as an additions-only diff (green `+` lines) grouped by
  // contact, matching the profile diff's styling. `captured` is [{slug, title,
  // deadline, importance, actionable}]; legacy records predate it → treat as [].
  const todoHtml = run.kind === 'todo'
    ? (() => {
        const captured = Array.isArray(run.captured) ? run.captured : [];
        if (!captured.length) {
          const trig = run.triggers || 0;
          return `<h2>Drafts captured</h2><pre class="diff"><span class="ctx">no drafts captured (${trig} trigger${trig === 1 ? '' : 's'} — paused, duplicates, or nothing extractable)</span></pre>`;
        }
        const bySlug = new Map();
        for (const c of captured) { const k = c.slug || ''; if (!bySlug.has(k)) bySlug.set(k, []); bySlug.get(k).push(c); }
        const panes = [...bySlug.entries()].map(([slug, items]) => {
          const lines = items.map((c) => {
            const bits = [`[${c.importance || '—'}]`, c.title || '(untitled)'];
            if (c.deadline) bits.push(`(due ${c.deadline})`);
            if (c.actionable === false) bits.push('[blocked]');
            return `<span class="add">+ ${esc(bits.join('  '))}</span>`;
          }).join('\n');
          const head = slug ? `<div class="difflabel">${esc(slug)}</div>` : '';
          return `${head}<pre class="diff">${lines}</pre>`;
        }).join('');
        return `<h2>Drafts captured</h2>${panes}`;
      })()
    : '';

  const warnHtml = (run.warnings || []).length
    ? `<h2>Warnings</h2><ul>${run.warnings.map((w) => `<li class="bad">${esc(w)}</li>`).join('')}</ul>`
    : '';

  // Which model wrote this run's output. Shown next to the diff links on
  // purpose: a profile diff is only interpretable if you know which model
  // produced it, and merge/timeline can now be pointed at different models.
  // run.models.timeline is the current field; .compact is the pre-rename spelling
  // still present in older records.
  const runTimelineModel = run.models && (run.models.timeline || run.models.compact);
  const modelsHtml = run.models
    ? `<span class="sub"> · merge <code>${esc(run.models.merge || '?')}</code>` +
      (runTimelineModel && runTimelineModel !== run.models.merge
        ? ` · timeline <code>${esc(runTimelineModel)}</code>` : '') + `</span>`
    : '';
  const cc = run.timelineCitations || run.compactCitations;
  const timelineCiteHtml = cc
    ? `<h2>Timeline citations</h2><p class="${cc.bad && cc.bad.length ? 'bad' : 'ok'}">` +
      (cc.bad && cc.bad.length
        ? `unresolvable ids in ${cc.bad.length} file(s): ${esc(cc.bad.join(' '))}`
        : `${cc.cited} cited ids across ${cc.files} files, all resolve`) + `</p>`
    : '';

  // Full run log, persisted per-run by crm-daily. Collapsed by default (long),
  // open automatically if the run failed so the error is right there.
  let logHtml = '';
  try {
    const logText = fs.readFileSync(path.join(RUNS_DIR, `${id}.log`), 'utf8');
    if (logText.trim()) {
      const failed = (run.mergeFailures || []).length > 0;
      logHtml = `<h2>Log</h2><details class="step"${failed ? ' open' : ''}>` +
        `<summary><span class="nm">full run output</span></summary>` +
        `<pre class="log">${esc(logText)}</pre></details>`;
    }
  } catch { /* older runs have no persisted log */ }

  // Estimated vs actual cost + duration for this run, when recorded.
  const money = (v, model) => (isFree(model) ? 'on plan' : fmtUsd(v == null ? null : v));
  const costHtml = (run.costUsd !== undefined || run.actualCostUsd !== undefined)
    ? `<span class="sub"> · cost est ${esc(money(run.costUsd, run.costModel))} · actual ${esc(money(run.actualCostUsd, run.costModel))}</span>`
    : '';

  // The kind chip wears the same job ink as the runs ledger (legacy records
  // predate `kind` and are all ingest runs).
  const kind = run.kind || 'ingest';
  const kindWord = { sweep: 'sweep', ingest: 'ingest', timeline: 'timeline', compact: 'timeline', todo: 'todo', manual: 'by hand' }[kind] || kind;
  const body = `<div class="back"><a href="/runs">&larr; All runs</a></div>` +
    `<header class="top"><h1>Run ${esc(fmtWhen(run.startedAt))}</h1>` +
    `<span class="mk ${esc(kind)}">${esc(kindWord)}</span>` +
    `<span class="sub">${esc(runMode(run))} · ${fmtMs(run.durationMs)}</span>${modelsHtml}${costHtml}</header>` +
    // A manual run's story is its steps + why + line diff; a todo run's is the
    // drafts it captured — neither has a contacts table.
    `<h2>Steps</h2>${stepsHtml}${manualHtml}${todoHtml}${(run.kind === 'manual' || run.kind === 'todo') ? '' : contactsHtml}${timelineCiteHtml}${warnHtml}${logHtml}`;
  return page(`Run ${run.id}`, body, '/runs');
}

// ---- profile history -------------------------------------------------------
// Every state a profile has been in, newest first. Git already stores a COMPLETE
// snapshot per commit (not a chain of patches to replay), so this is a read: one
// `git log -p` gives every version and its diff in a single subprocess.
//
// --follow so a rename does not truncate the history at the rename point.

const HIST_REC = '\x00';   // record separator — cannot appear in a commit
const HIST_FLD = '\x1f';   // field separator

function contactHistory(slug, limit = 300) {
  // %x00/%x1f, not the literal bytes: Node's execFileSync rejects any argv
  // entry containing a NUL, so git has to be the one that emits the separator.
  // %B (the whole message) and regex, NOT %(trailers:key=…). Git only parses
  // trailers in the final paragraph after a blank line, so a commit written with
  // a single newline before them has the data present but unreadable as
  // trailers. Regexing the body reads both shapes, which matters because the
  // first real backfill produced the malformed kind.
  const fmt = ['%x00%H', '%at', '%s', '%B', ''].join('%x1f');
  let out;
  try {
    out = execFileSync('git', [
      '--git-dir', GITDIR, 'log', `--max-count=${limit}`, '--follow',
      `--format=${fmt}`, '-p', '--', `data/contacts/${slug}.md`,
    ], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
  // SECOND QUERY, for the commits the first one structurally cannot return.
  // `git log -- <path>` lists only commits that CHANGED that path, so a merge
  // that correctly decided to change nothing is absent — the single entry most
  // worth auditing is the one that silently disappears. Chunk commits name their
  // slug in the subject, so grep finds them regardless of what they touched.
  let extra = '';
  try {
    extra = execFileSync('git', [
      '--git-dir', GITDIR, 'log', `--max-count=${limit}`,
      `--format=${fmt}`, `--grep=^merge ${slug} `, '--extended-regexp',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  } catch { /* none */ }

  const seen = new Set();
  return [...out.split(HIST_REC), ...extra.split(HIST_REC)].filter((r) => {
    if (!r.trim()) return false;
    const sha = r.split(HIST_FLD)[0].trim();
    if (seen.has(sha)) return false;   // path query wins: it carries the patch
    seen.add(sha);
    return true;
  }).map((rec) => {
    const parts = rec.split(HIST_FLD);
    const [sha, at, subject, body] = parts;
    const field = (k) => {
      const m = new RegExp(`^${k}:[ \\t]*(.+)$`, 'm').exec(body || '');
      return m ? m[1].trim() : '';
    };
    const model = field('Model');
    const prompt = field('Prompt');
    const run = field('Run');
    // Chunk commits carry their provenance in the subject; parse it so the
    // message span can link back to the messages that caused the change.
    const m = /^merge\s+(\S+)\s+(\S+)\s+\((\d+)\s+msgs?,\s*m(\d+)\.\.m(\d+)\)(?:\s*\[(\d+)\/(\d+)\])?/.exec(subject || '');
    return {
      sha: (sha || '').trim(),
      at: Number(at) * 1000,
      // On the malformed commits the trailers are folded into the subject, so
      // cut them off for display rather than showing them twice.
      subject: (subject || '').split(/\s+Model:\s/)[0].trim(),
      model: (model || '').trim(),
      prompt: (prompt || '').trim(),
      run: (run || '').trim(),
      chunk: m ? { label: m[2], msgs: Number(m[3]), from: Number(m[4]), to: Number(m[5]), i: m[6], n: m[7] } : null,
      patch: parts.slice(4).join(HIST_FLD),
    };
    // The two queries are each sorted, but their union is not.
  }).sort((a, b) => b.at - a.at);
}

function renderPatch(patch) {
  const lines = String(patch || '').split('\n')
    // diff --git / index / +++ / --- headers are noise when the file is already
    // named by the page itself.
    .filter((l) => !/^(diff --git |index |--- |\+\+\+ |new file mode |similarity index |rename )/.test(l));
  const body = lines.map((l) => {
    const e = esc(l);
    if (l.startsWith('@@')) return `<span class="hunk">${e}</span>`;
    if (l.startsWith('+')) return `<span class="add">${e}</span>`;
    if (l.startsWith('-')) return `<span class="del">${e}</span>`;
    return `<span class="ctx">${e}</span>`;
  }).join('\n').trim();
  return body || '<span class="ctx">(no textual change to this profile)</span>';
}

// THE SPOT-CHECK VIEW. A merge that changed nothing is either correct restraint
// or a silent failure, and the profile diff cannot tell you which — it is empty
// in both cases. Answering it needs the two things the merge actually saw: the
// ledger it was given, and the profile as it stood at that moment.
//
// Both are recoverable because the chunk commit captured them: data/contacts/
// _refresh/<slug>.new.txt is overwritten per chunk, so its content AT THAT
// COMMIT is exactly that chunk's input. That is the reason _refresh is kept in
// the history repo rather than excluded as scratch.
function ledgerPage(slug, sha) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  const show = (rev, p) => {
    try {
      return execFileSync('git', ['--git-dir', GITDIR, 'show', `${rev}:${p}`],
        { cwd: ROOT, encoding: 'utf8', timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    } catch { return null; }
  };
  const ledger = show(sha, `data/contacts/_refresh/${slug}.new.txt`);
  if (ledger === null) return null;
  // The PARENT's profile: this commit holds the POST-merge state, and the question
  // being asked is what the merge was looking at when it decided. For a no-op
  // chunk the two are identical anyway. Falls back to this commit for a root
  // commit, which has no parent.
  const profile = show(`${sha}^`, `data/contacts/${slug}.md`)
    ?? show(sha, `data/contacts/${slug}.md`);

  let subject = '';
  try {
    subject = execFileSync('git', ['--git-dir', GITDIR, 'log', '-1', '--format=%s', sha],
      { cwd: ROOT, encoding: 'utf8', timeout: 10_000 }).split(/\s+Model:\s/)[0].trim();
  } catch { /* unnamed */ }

  const lines = ledger.split('\n');
  const rows = lines.map((l) => {
    const m = /^\[([^\]]+)\]\s+⟨m(\d+)⟩\s+(?:\(([^)]*)\)\s+)?([^:]+):\s*([\s\S]*)$/.exec(l);
    if (!m) return l.trim() ? `<div class="lmeta">${esc(l)}</div>` : '';
    const mine = /^nathan$/i.test(m[4]);
    return `<div class="lrow ${mine ? 'me' : 'them'}">`
      + `<a class="lid" href="/m/${m[2]}" target="_blank" rel="noopener">m${m[2]}</a>`
      + `<span class="lts">${esc(m[1])}</span>`
      + `<span class="lwho">${esc(m[4])}</span>`
      + `<span class="lbody">${inline(m[5])}</span></div>`;
  }).join('');
  const counted = lines.filter((l) => /^\[[^\]]+\]\s+⟨m\d+⟩/.test(l)).length;

  // The profile's judged sections only — the Timeline is the Timeline step's and
  // would bury the thing you are checking.
  const judged = profile
    ? profile.split(/^## Timeline/m)[0]
    : '(profile not present at this commit)';

  const st = `<style>
    .lrow{display:grid;grid-template-columns:64px 128px 92px 1fr;gap:8px;padding:2px 6px;font-size:13px;border-bottom:1px solid #1c2027}
    .lrow.me{background:#161b22}
    .lid{color:#7aa2f7;font-family:ui-monospace,monospace;font-size:11px}
    .lts,.lwho{color:#8b93a4;font-size:11px}
    .lbody{white-space:pre-wrap;word-break:break-word}
    .lmeta{color:#8b93a4;font-size:12px;padding:6px}
    .two{display:grid;grid-template-columns:1fr;gap:16px}
    .pane{border:1px solid #2a2f3a;border-radius:8px;overflow:hidden}
    .pane h2{margin:0;padding:8px 12px;background:#1b1f27;font-size:13px}
    .pane .inner{max-height:70vh;overflow:auto}
    .pane pre{margin:0;padding:10px;white-space:pre-wrap;font-size:13px}
  </style>`;

  const body = st
    + `<div class="back"><a href="/c/${encodeURIComponent(slug)}/history">&larr; ${esc(slug)} history</a></div>`
    + `<header class="top"><h1>Spot check &mdash; ${esc(slug)}</h1>`
    + `<span class="sub">${esc(subject || sha.slice(0, 8))} &middot; ${counted} messages in this chunk</span></header>`
    + `<div class="two">`
    + `<div class="pane"><h2>Profile as the merge saw it (judged sections only)</h2>`
    + `<div class="inner"><pre>${esc(judged)}</pre></div></div>`
    + `<div class="pane"><h2>Ledger the merge was given &mdash; ${counted} messages</h2>`
    + `<div class="inner">${rows}</div></div>`
    + `</div>`;
  return page(`${slug} — spot check`, body);
}

function historyPage(slug) {
  // `git log` on a path that never existed exits 0 with no output, so an unknown
  // contact would otherwise render an empty page with HTTP 200 instead of 404.
  if (!fs.existsSync(path.posix.join(CONTACTS_DIR, `${slug}.md`))) return null;
  const hist = contactHistory(slug);
  if (!hist) return null;

  const changed = hist.filter((h) => h.patch && h.patch.trim());
  const models = [...new Set(hist.map((h) => h.model).filter(Boolean))];
  const st = `<style>
    .hentry{border:1px solid #2a2f3a;border-radius:8px;margin:14px 0;overflow:hidden}
    .hhead{padding:8px 12px;background:#1b1f27;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
    .hhead .when{font-weight:600}
    .hsub{color:#8b93a4;font-size:12px;flex:1 1 100%}
    .badge{font-size:11px;padding:2px 7px;border-radius:10px;background:#262b36;color:#c3cad8;white-space:nowrap}
    .badge.model{background:#1e3a2b;color:#8fe3ac}
    .badge.prompt{background:#2b2440;color:#c4aef5}
    .hentry pre.diff{margin:0;border-top:1px solid #2a2f3a;border-radius:0}
    .hmeta{color:#8b93a4;font-size:12px;margin:2px 0 14px}
  </style>`;

  const entries = hist.map((h) => {
    const badges = [
      h.model ? `<span class="badge model">${esc(h.model)}</span>` : '',
      h.prompt ? `<span class="badge prompt">${esc(h.prompt)}</span>` : '',
      h.chunk && h.chunk.i ? `<span class="badge">chunk ${esc(h.chunk.i)}/${esc(h.chunk.n)}</span>` : '',
      `<span class="badge">${esc(h.sha.slice(0, 8))}</span>`,
    ].join('');
    // The rowid span in the subject is exactly the ledger that produced this
    // edit, and /m/<id> already renders a message in context — so a change can
    // be traced to the words that caused it.
    // A no-change entry is the one you most need to inspect, and its diff is
    // empty by definition — so the spot-check link matters most exactly where
    // this page has least to show.
    const spot = `<a href="/c/${encodeURIComponent(slug)}/ledger/${h.sha}">spot check &rarr;</a>`;
    const src = h.chunk
      ? `<span class="hsub">${h.chunk.msgs} messages · ${esc(h.chunk.label)} · `
        + `<a href="/m/${h.chunk.from}" target="_blank" rel="noopener">m${h.chunk.from}</a>…<a href="/m/${h.chunk.to}" target="_blank" rel="noopener">m${h.chunk.to}</a>`
        + ` · ${spot}</span>`
      : `<span class="hsub">${esc(h.subject)} · ${spot}</span>`;
    const empty = !h.patch || !h.patch.trim();
    return `<div class="hentry"><div class="hhead">`
      + `<span class="when">${esc(fmtWhen(h.at))}</span>${badges}`
      + (empty ? '<span class="badge">no profile change</span>' : '')
      + `${src}</div>`
      + `<pre class="diff">${renderPatch(h.patch)}</pre></div>`;
  }).join('');

  const body = st
    + `<div class="back"><a href="/c/${encodeURIComponent(slug)}">&larr; ${esc(slug)}</a></div>`
    + `<header class="top"><h1>${esc(slug)} — history</h1>`
    + `<span class="sub">${hist.length} version${hist.length === 1 ? '' : 's'}, ${changed.length} with changes</span></header>`
    + `<p class="hmeta">${models.length ? `models: ${esc(models.join(', '))}` : 'no model recorded on these commits (they pre-date provenance trailers)'}</p>`
    + (entries || '<p>No history recorded for this profile yet.</p>');
  return page(`${slug} — history`, body);
}

// The client-side diff viewer: computes the line diff from the full pre/post
// images, renders it GitLab-style (unified OR side-by-side, remembered per
// browser), collapses long unchanged runs behind expandable stubs, and marks
// where the `## Timeline` section begins. No backticks / ${…} / real newlines in
// here — it is embedded in a template literal, so it uses '+' concatenation and
// single quotes only (mirrors PROFILE_EDIT_JS).
const DIFF_VIEW_JS = `
(function(){
  var D=__DIFF_DATA__;
  var mount=document.getElementById('diffmount');
  if(!mount)return;
  var A=D.A||[],B=D.B||[],tl=(D.timelineB==null?-1:D.timelineB);
  var CTX=3,STEP=20;
  function escH(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  // LCS line diff (common prefix/suffix trim), same shape as the edit viewer.
  function diffLines(a,b){
    var s=0;while(s<a.length&&s<b.length&&a[s]===b[s])s++;
    var e=0;while(e<a.length-s&&e<b.length-s&&a[a.length-1-e]===b[b.length-1-e])e++;
    var ac=a.slice(s,a.length-e),bc=b.slice(s,b.length-e),n=ac.length,m=bc.length;
    var dp=new Uint32Array((n+1)*(m+1)),W=m+1;
    for(var i=n-1;i>=0;i--)for(var j=m-1;j>=0;j--)
      dp[i*W+j]=ac[i]===bc[j]?dp[(i+1)*W+j+1]+1:Math.max(dp[(i+1)*W+j],dp[i*W+j+1]);
    var ops=[],x=0,y=0;
    for(var p=0;p<s;p++)ops.push({t:'=',a:p,b:p});
    while(x<n&&y<m){
      if(ac[x]===bc[y]){ops.push({t:'=',a:s+x,b:s+y});x++;y++;}
      else if(dp[(x+1)*W+y]>=dp[x*W+y+1]){ops.push({t:'-',a:s+x});x++;}
      else{ops.push({t:'+',b:s+y});y++;}
    }
    while(x<n){ops.push({t:'-',a:s+x});x++;}
    while(y<m){ops.push({t:'+',b:s+y});y++;}
    for(var z=0;z<e;z++)ops.push({t:'=',a:a.length-e+z,b:b.length-e+z});
    return ops;
  }
  var ops=diffLines(A,B);
  // Segment into alternating change / unchanged-gap runs.
  var SEGS=[];{var cur=null;for(var i=0;i<ops.length;i++){var g=ops[i].t==='=';if(!cur||cur.gap!==g){cur={gap:g,ops:[]};SEGS.push(cur);}cur.ops.push(ops[i]);}}
  SEGS.forEach(function(sg,i){sg.id='g'+i;sg.isFirst=(i===0);sg.isLast=(i===SEGS.length-1);});
  var exp={};
  var mode='unified';try{var mm=localStorage.getItem('crm.diffmode');if(mm==='split'||mm==='unified')mode=mm;}catch(e){}
  function tlBar(cols,op){return (tl>=0&&op&&op.b===tl)?('<tr class="dtl"><td colspan="'+cols+'">Timeline &darr;</td></tr>'):'';}
  // ---- unified rows ----
  function ctxU(op){return tlBar(4,op)+'<tr><td class="dn">'+(op.a+1)+'</td><td class="dn">'+(op.b+1)+'</td><td class="dsign"> </td><td class="dc">'+escH(A[op.a])+'</td></tr>';}
  function chgU(sg){var r=[];sg.ops.forEach(function(op){if(op.t==='-')r.push('<tr class="ddel"><td class="dn">'+(op.a+1)+'</td><td class="dn"></td><td class="dsign">-</td><td class="dc">'+escH(A[op.a])+'</td></tr>');else r.push(tlBar(4,op)+'<tr class="dadd"><td class="dn"></td><td class="dn">'+(op.b+1)+'</td><td class="dsign">+</td><td class="dc">'+escH(B[op.b])+'</td></tr>');});return r.join('');}
  // ---- split rows ----
  function ctxS(op){return tlBar(4,op)+'<tr><td class="dn">'+(op.a+1)+'</td><td class="dc">'+escH(A[op.a])+'</td><td class="dn">'+(op.b+1)+'</td><td class="dc">'+escH(B[op.b])+'</td></tr>';}
  function chgS(sg){var r=[],i=0,o=sg.ops;while(i<o.length){var del=[],add=[];while(i<o.length&&o[i].t==='-'){del.push(o[i]);i++;}while(i<o.length&&o[i].t==='+'){add.push(o[i]);i++;}for(var k=0;k<Math.max(del.length,add.length);k++){var L=del[k],R=add[k];r.push((R?tlBar(4,R):'')+'<tr>'+(L?'<td class="dn ddel">'+(L.a+1)+'</td><td class="dc ddel">'+escH(A[L.a])+'</td>':'<td class="dn"></td><td class="dc dgap"></td>')+(R?'<td class="dn dadd">'+(R.b+1)+'</td><td class="dc dadd">'+escH(B[R.b])+'</td>':'<td class="dn"></td><td class="dc dgap"></td>')+'</tr>');}}return r.join('');}
  function stub(sg,hidden){var b='';if(!sg.isFirst)b+='<button class="dxp" data-gap="'+sg.id+'" data-act="top" aria-label="show more below the previous change">&darr; '+STEP+'</button>';b+='<button class="dxp" data-gap="'+sg.id+'" data-act="all">&#8597; '+hidden+' unchanged lines</button>';if(!sg.isLast)b+='<button class="dxp" data-gap="'+sg.id+'" data-act="bottom" aria-label="show more above the next change">&uarr; '+STEP+'</button>';return '<tr class="dstub"><td colspan="4">'+b+'</td></tr>';}
  function gap(sg,ctx){var L=sg.ops.length,st=exp[sg.id]||{};var top=sg.isFirst?0:CTX,bot=sg.isLast?0:CTX;if(st.all){return sg.ops.map(ctx).join('');}top+=(st.top||0);bot+=(st.bottom||0);if(top+bot>=L)return sg.ops.map(ctx).join('');var r=[],j;for(j=0;j<top;j++)r.push(ctx(sg.ops[j]));r.push(stub(sg,L-top-bot));for(j=L-bot;j<L;j++)r.push(ctx(sg.ops[j]));return r.join('');}
  function render(){
    var split=mode==='split';var ctxFn=split?ctxS:ctxU;
    var rows=SEGS.map(function(sg){return sg.gap?gap(sg,ctxFn):(split?chgS(sg):chgU(sg));}).join('');
    mount.innerHTML='<div class="diffview"><table class="dtab'+(split?' split':'')+'">'+rows+'</table></div>';
    var u=document.getElementById('dmUni'),s=document.getElementById('dmSplit');
    if(u)u.classList.toggle('on',!split);if(s)s.classList.toggle('on',split);
  }
  mount.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('button.dxp');if(!b)return;
    var id=b.getAttribute('data-gap'),act=b.getAttribute('data-act');var st=exp[id]||(exp[id]={});
    if(act==='all')st.all=true;else if(act==='top')st.top=(st.top||0)+STEP;else st.bottom=(st.bottom||0)+STEP;
    render();
  });
  var tb=document.getElementById('difftools');
  if(tb)tb.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button[data-mode]');if(!b)return;mode=b.getAttribute('data-mode');try{localStorage.setItem('crm.diffmode',mode);}catch(x){}render();});
  render();
})();
`;

function diffPage(id, slug, chunkIdx) {
  let run;
  try { run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${id}.json`), 'utf8')); } catch { return null; }
  // A chunk index selects that chunk's own commit pair, so the diff shows what
  // ONE week-aligned merge did rather than everything the run touched.
  const chunk = chunkIdx != null && run.chunks ? run.chunks[chunkIdx] : null;
  const pre = (chunk && chunk.preSha) || run.preSha;
  const post = (chunk && chunk.postSha) || run.postSha;
  if (!pre || !post) return null;
  const rel = `data/contacts/${slug}.md`;
  const showFile = (sha) => {
    try {
      return execFileSync('git', ['--git-dir', GITDIR, 'show', `${sha}:${rel}`],
        { cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    } catch { return null; } // file absent at this revision (e.g. profile created this run)
  };
  const preText = showFile(pre);
  const postText = showFile(post);
  const splitLines = (t) => (t == null ? [] : t.replace(/\n$/, '').split('\n'));
  const A = splitLines(preText);
  const B = splitLines(postText);
  // The profile .md holds both the merge-written prose AND the `## Timeline`
  // section (owned by the Timeline step). One divider row marks where Timeline starts.
  const timelineB = B.findIndex((l) => /^##\s+Timeline\b/.test(l));

  const backHeader = `<div class="back"><a href="/runs/${encodeURIComponent(id)}">&larr; back to run</a></div>` +
    `<header class="top"><h1>${esc(slug)} — changes</h1><span class="sub">run ${esc(fmtWhen(run.startedAt))}</span></header>`;

  if (preText == null && postText == null) {
    return page(`diff ${slug}`, backHeader + '<pre class="diff"><span class="ctx">(could not read this profile at either revision)</span></pre>', '/runs');
  }
  if (preText != null && postText != null && preText === postText) {
    return page(`diff ${slug}`, backHeader + '<pre class="diff"><span class="ctx">(no changes to this profile in this run)</span></pre>', '/runs');
  }

  // CAP. The interactive viewer diffs the whole file client-side (O(n·m)); above
  // this it falls back to a classic fixed-context unified diff so a pathological
  // profile can't hang the browser. Real profiles are a few hundred lines.
  const MAXLINES = 6000;
  if (A.length + B.length > MAXLINES) {
    let diff = '';
    try {
      diff = execFileSync('git', ['--git-dir', GITDIR, 'diff', `${pre}..${post}`, '--', rel],
        { cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    } catch { /* leave empty */ }
    const styled = diff.split('\n').map((l) => {
      const e = esc(l);
      if (l.startsWith('@@')) return `<span class="hunk">${e}</span>`;
      if (l.startsWith('+')) return `<span class="add">${e}</span>`;
      if (l.startsWith('-')) return `<span class="del">${e}</span>`;
      return `<span class="ctx">${e}</span>`;
    }).join('\n');
    return page(`diff ${slug}`,
      backHeader + `<p class="sub">Large profile (${A.length + B.length} lines) — showing a plain unified diff.</p><pre class="diff">${styled}</pre>`,
      '/runs');
  }

  const payload = JSON.stringify({ A, B, timelineB: timelineB === -1 ? null : timelineB })
    .replace(/</g, '\u003c');
  const tools = '<div class="difftools" id="difftools">' +
    '<span class="difftlab">view</span>' +
    '<button type="button" class="dtbtn on" id="dmUni" data-mode="unified">unified</button>' +
    '<button type="button" class="dtbtn" id="dmSplit" data-mode="split">side by side</button></div>';
  const script = `<script>${DIFF_VIEW_JS.replace('__DIFF_DATA__', payload)}</script>`;
  return page(`diff ${slug}`, backHeader + tools + '<div id="diffmount"></div>' + script, '/runs');
}

// ---------------------------------------------------------------------------
// Screen C — the pipeline jobs: sweep / deep-sweep / ingest / todo, launched from /admin
// ---------------------------------------------------------------------------
// In-memory single-job lock: one run at a time, so two launches can never
// interleave cursor state (a second launch while one runs is rejected with 409).
// A job runs a QUEUE of commands sequentially — one per selected person — and
// stops at the first failure rather than cascading model calls into a broken run.
let job = null;

// Per-step wall-clock cap for a launched job (P5-6): a hung child can't hold the
// pipeline lock past this. Generous — a big backfill chunk-merge is legitimately
// long; this only catches a genuine hang. Override with CRM_JOB_TIMEOUT_MS.
const JOB_STEP_TIMEOUT_MS = Number(process.env.CRM_JOB_TIMEOUT_MS) || 60 * 60 * 1000;

// GRACEFUL SHUTDOWN (P5-1). On SIGTERM (systemctl stop/restart, or a bare `kill`) or
// SIGINT, don't just die and orphan a running job's children — they'd keep writing
// crm.db while the respawned server, seeing a now-dead-PID lock, judges it stale and
// STEALS it → two concurrent writers. Kill the job's whole process GROUP (it runs
// detached, so -pid targets the tree), release the lock, then exit 0 so systemd's
// Restart=always brings up a clean instance. The aborted ingest is crash-safe
// (per-chunk merge frontier), so it simply resumes on the next run.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (job && job.running && job.child && job.child.pid) {
      try { process.kill(-job.child.pid, 'SIGTERM'); } catch { try { job.child.kill('SIGTERM'); } catch { /* already gone */ } }
    }
    if (job && job.lock) { try { job.lock.release(); } catch { /* ok */ } job.lock = null; }
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const ARCHIVE_JS = path.join(ROOT, 'scripts', 'crm-archive.js');
const DAILY_JS = path.join(ROOT, 'scripts', 'crm-daily.js');
const TODO_JS = path.join(ROOT, 'scripts', 'crm-todo-scan.js');
// NOTE: there is no timeline job here. Timeline is ingest's second half (see
// lib/jobs.js); crm-daily.js runs it. The only launchable jobs are the four in
// lib/jobs.js — sweep, deep-sweep (a sweep with --deep), ingest, and todo.

// A job spec → the argv(s) to run. The PAID jobs pass --force, since a
// hand-started run from the UI always bypasses the run-toggle pause (the confirm
// modal already showed its cost); the free sweeps have no toggle, so they don't.
// An empty `slugs` means "everyone": sweep has a native all-people pass (run
// once), while ingest is per-contact by design (crm-daily --only, which also
// builds that contact's Timeline), so it expands to every tracked slug.
//   sweep   → crm-archive.js  [--only <slug>] [--deep]           (free, no model)
//   ingest  → crm-daily.js    --only <slug> --force              (merge + timeline)
//   todo    → crm-todo-scan.js --allow-paid --force              (global "make sure" scan)
// CSRF guard for mutating routes. Basic-auth credentials are auto-attached by the
// browser on ANY request to this origin with no SameSite protection, so a forged
// cross-site POST would carry them and could fire a paid run or flip a toggle.
// Require a first-party signal: Sec-Fetch-Site must be same-origin/same-site;
// anything else — including 'none' (file:// pages, some proxies/extensions) and
// cross-site — is refused. When the header is absent (older client), fall back to
// an Origin whose host matches Host; absent both, allow (a no-JS same-origin form
// post or a local CLI probe, still gated by basic auth).
function firstPartyOnly(req) {
  const sfs = (req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs) return sfs === 'same-origin' || sfs === 'same-site';
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function jobCommands({ kind, slugs, deep, plan }) {
  if (kind === 'sweep') {
    const people = slugs.length ? slugs : [null];
    return people.map((s) => [ARCHIVE_JS, ...(s ? ['--only', s] : []), ...(deep ? ['--deep'] : [])]);
  }
  if (kind === 'ingest') {
    const people = slugs.length ? slugs : loadTrackedSlugs();
    // --force: a hand-started run always bypasses the web-UI run-toggle pause.
    return people.map((s) => [DAILY_JS, '--only', s, ...(plan ? ['--dry-run'] : []), '--force']);
  }
  if (kind === 'todo') {
    // Global — reads the whole archive, not per-contact; slugs are ignored.
    // --allow-paid so a web-triggered scan may call the paid model on a match;
    // --force so a hand-started scan bypasses the run-toggle pause.
    return [[TODO_JS, '--write', '--allow-paid', '--force']];
  }
  return null;
}

function startJob(spec) {
  if (job && job.running) return { ok: false, error: 'a run is already in progress' };
  // Derive the allow-list from the jobs.js SSOT (isJob) so a new job added there is
  // launchable without editing this guard. deep-sweep is unfolded to kind 'sweep'
  // (+deep) before it reaches here, so it is excluded — it is a flag, not a
  // launchable kind. Timeline is not a job.
  if (!JOBS_DEF.isJob(spec.kind) || spec.kind === 'deep-sweep') return { ok: false, error: 'bad job kind' };
  const cmds = jobCommands(spec);
  if (!cmds || !cmds.length) return { ok: false, error: 'nothing to run (no such people?)' };
  // Cross-process lock: refuse if a scheduled sweep or a CLI run is mid-flight,
  // so two processes never write crm.db / a profile at once. The server is idle
  // here (no job.running), so any lingering env flag is stale from a prior job —
  // clear it so acquire() takes a REAL file lock, not a nested no-op. The
  // children spawned by runQueue inherit the flag acquire() sets and skip
  // re-locking, which is what keeps them from deadlocking on this same lock.
  delete process.env.CRM_PIPELINE_LOCK_HELD;
  const lock = require('../lib/pipeline-lock').acquire(`web:${spec.kind}`);
  if (!lock.ok) return { ok: false, error: `another pipeline run is active (${lock.holderDesc})` };
  const now = Date.now();
  job = {
    id: new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19),
    kind: spec.kind, deep: !!spec.deep, plan: !!spec.plan,
    scope: spec.slugs.length ? spec.slugs.join(', ') : 'everyone',
    total: cmds.length, done: 0,
    startedAt: now, endedAt: null, running: true, exit: null, buf: '', lock,
  };
  runQueue(cmds, 0);
  return { ok: true, id: job.id };
}

function runQueue(cmds, i) {
  if (i >= cmds.length) {
    job.running = false;
    job.child = null;
    job.endedAt = Date.now();
    if (job.exit == null) job.exit = 0;
    job.buf += `\n[done — ${cmds.length} step(s), exit ${job.exit}]`;
    if (job.lock) { job.lock.release(); job.lock = null; }
    return;
  }
  job.done = i;
  const argv = cmds[i];
  const pretty = argv.map((a) => (a.startsWith(ROOT) ? path.basename(a) : a)).join(' ');
  job.buf += (job.buf ? '\n\n' : '') + `$ node ${pretty}\n`;
  // `detached` puts the child in its OWN process group so the watchdog can kill the
  // whole tree (crm-daily and the `pi` model calls it spawns), not just the parent.
  const child = spawn(process.execPath, argv, { cwd: ROOT, detached: true });
  job.child = child; // so the shutdown handler (P5-1) can kill this step's tree
  const append = (d) => {
    job.buf += d.toString();
    if (job.buf.length > 400_000) job.buf = job.buf.slice(-400_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  // WATCHDOG (P5-6): a per-step wall-clock cap so a hung child can't hold the
  // pipeline lock indefinitely. Inner steps (pi calls) have their own 10-min
  // timeouts; this bounds the STEP as a whole. Kill the child's process GROUP so pi
  // grandchildren die too; the signal death then flows through the failure branch
  // below (code=null). Generous default — this catches a hang, not a long run.
  const killTree = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
  const watchdog = setTimeout(() => {
    job.buf += `\n[step ${i + 1}/${cmds.length} exceeded ${Math.round(JOB_STEP_TIMEOUT_MS / 60000)}m — killing]`;
    killTree('SIGKILL');
  }, JOB_STEP_TIMEOUT_MS);
  child.on('close', (code, signal) => {
    clearTimeout(watchdog);
    // A child killed by a signal (the watchdog, or OOM SIGKILL) reports code=null —
    // treat that as failure, not success, so the queue stops instead of marching on
    // as if the step had passed.
    if (code || signal) {
      job.exit = code == null ? -1 : code;
      job.running = false;
      job.child = null;
      job.endedAt = Date.now();
      job.buf += `\n[step ${i + 1}/${cmds.length} ${signal ? `killed by ${signal}` : `exit ${code}`} — stopped]`;
      if (job.lock) { job.lock.release(); job.lock = null; }
      return;
    }
    job.done = i + 1;
    runQueue(cmds, i + 1);
  });
  child.on('error', (e) => {
    clearTimeout(watchdog);
    job.exit = -1;
    job.running = false;
    job.child = null;
    job.endedAt = Date.now();
    job.buf += `\n[spawn error: ${e.message}]`;
    if (job.lock) { job.lock.release(); job.lock = null; }
  });
}

// Chunk-level progress, parsed from the streamed crm-daily output. What streams
// LIVE per chunk is crm-merge's own banner (`crm-merge: <slug>: -> <model>
// [i/total …] ...`) and its `crm-merge: <slug>: ok ($…)` completion line —
// crm-daily's `[4] merge … ok, cursor -> …` lines are buffered in logLines and
// only hit stdout in one dump when the whole run ends. So: highest total seen in
// any banner is the plan size, and chunks done is the count of crm-merge ok
// lines while running (max'd with the cursor lines so the final dump doesn't
// double-count). ETA extrapolates the live per-chunk rate; the Timeline
// phase is indeterminate.
function parseJobProgress(buf, elapsedMs) {
  const s = String(buf || '');
  const marks = [...s.matchAll(/[\[ ](\d+)\/(\d+)[\s(\]]/g)];
  let total = null;
  for (const m of marks) { const t = +m[2]; if (t > 1 && t < 1000) total = t; }
  if (total == null) return null;
  const done = Math.max(
    (s.match(/: ok, cursor ->/g) || []).length,
    (s.match(/^crm-merge: .+?: ok\b/gm) || []).length,
  );
  const timeline = /\[5\] timeline|crm-timeline:/.test(s);
  const phase = (done >= total || timeline) ? 'timeline' : 'ingest';
  let etaMs = null;
  if (phase === 'ingest' && done > 0 && elapsedMs > 0) etaMs = Math.max(0, (total - done) * (elapsedMs / done));
  return { total, done, phase, fraction: Math.max(0, Math.min(1, done / total)), etaMs };
}

// Shape the in-memory job for the V.job monitor component and status.json.
function jobToView() {
  if (!job) return null;
  const status = job.running ? 'running' : (job.exit ? 'failed' : 'done');
  const elapsedMs = (job.endedAt || Date.now()) - job.startedAt;
  const prog = job.running ? parseJobProgress(job.buf, elapsedMs) : null;
  const step = job.total > 1
    ? (job.running ? `person ${job.done + 1} of ${job.total}` : `${job.done} of ${job.total} done`)
    : (job.running ? 'running' : status);
  return {
    id: job.id,
    kind: job.kind[0].toUpperCase() + job.kind.slice(1) + (job.deep ? ' · deep' : '') + (job.plan ? ' · plan' : ''),
    scope: job.scope,
    status,
    startedAt: ptLocal(job.startedAt) + ' PT',
    elapsed: fmtMs(elapsedMs),
    step,
    model: job.kind === 'sweep' ? 'no model' : MERGE_MODEL,
    progress: prog ? {
      total: prog.total, done: prog.done, phase: prog.phase,
      pct: Math.round(prog.fraction * 100),
      eta: prog.etaMs != null ? fmtMs(prog.etaMs) : null,
    } : null,
    log: job.buf || '(no output yet)',
  };
}

// The job monitor. Server-renders the current state, then polls status.json to
// stream the log live; when the run ends it reloads once for the final stamp.
function jobPage() {
  const j = jobToView();
  if (!j) {
    return page('No job — personal-crm',
      '<div class="back"><a href="/admin">&larr; pipeline</a></div>' +
      '<p class="sub">No job has been launched yet. Start one from the ' +
      '<a href="/admin">pipeline desk</a>.</p>', '/admin');
  }
  const poll = `<script>(function(){
    if(${j.status === 'running'} !== true) return;
    function tick(){
      fetch('/admin/jobs/status.json').then(function(r){return r.json();}).then(function(d){
        if(!d.job) return;
        var pre=document.querySelector('.joblog');
        if(pre){pre.textContent=d.job.log;pre.scrollTop=pre.scrollHeight;}
        var pg=d.job.progress,fill=document.getElementById('pbarFill'),bar=document.getElementById('pbar'),lab=document.getElementById('progLab');
        if(pg&&fill&&bar&&lab){
          bar.setAttribute('data-phase',pg.phase);
          fill.style.width=(pg.phase==='ingest'?pg.pct:100)+'%';
          lab.textContent=pg.phase==='timeline'?('ingest complete ('+pg.total+'/'+pg.total+') · building Timeline…'):('ingesting · chunk '+pg.done+'/'+pg.total+(pg.eta?' · ~'+pg.eta+' left':''));
        }
        if(d.job.status==='running'){setTimeout(tick,1500);}else{location.reload();}
      }).catch(function(){setTimeout(tick,2500);});
    }
    setTimeout(tick,1200);
  })();</script>`;
  return page(`${j.kind} — job ${j.id}`, render(V.job(j).body) + poll);
}

function readBody(req, cb, limit = 64_000) {
  let buf = '';
  let over = false;
  req.on('data', (d) => {
    buf += d.toString();
    if (buf.length > limit) { over = true; req.destroy(); }
  });
  req.on('end', () => { if (!over) cb(buf); });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
function isSafeSlug(s) { return /^[a-z0-9._-]+$/i.test(s) && !s.includes('..'); }
function isSafeRunId(s) { return /^[A-Za-z0-9-]+$/.test(s); }

function start() {
  const PASSWORD = resolvePassword();
  const server = http.createServer((req, res) => {
    const akey = authKey(req);
    const blockedMs = authBlockedMs(akey);
    if (blockedMs > 0) {
      res.writeHead(429, { 'Retry-After': String(Math.ceil(blockedMs / 1000)), 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Too many failed attempts — try again in ${Math.ceil(blockedMs / 1000)}s.`);
      return;
    }
    if (!authOk(req.headers.authorization, WEB_USER, PASSWORD)) {
      authNoteFailure(akey);
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Personal CRM", charset="UTF-8"' });
      res.end('Authentication required');
      return;
    }
    authClear(akey);
    const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
    const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    // A malformed request must never kill the server: `new URL` throws on
    // bogus absolute-form targets and decodeURIComponent throws on bad
    // percent-encoding (e.g. /c/%zz) — both were uncaught process crashes.
    try {
      const url = new URL(req.url, 'http://localhost');

      // Self-hosted woff2 (see lib/view/shell.js). Immutable: the files only
      // change with a redesign, which also changes the shell's fonts.css.
      if (url.pathname.startsWith('/fonts/')) {
        try {
          const buf = fs.readFileSync(path.join(FONTS_DIR, path.basename(url.pathname)));
          res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' });
          res.end(buf);
        } catch { res.writeHead(404); res.end(); }
        return;
      }

      // The Layer-1 escape hatch: decrypt an attachment on demand and serve the
      // ORIGINAL file. Auth-gated like everything (top of the handler); no CSRF check —
      // it's a GET opened in a new tab (a top-level navigation sends Sec-Fetch-Site
      // 'none', which firstPartyOnly rejects, and there's nothing to forge on a read).
      // Browser-viewable types open inline (new tab); everything else downloads.
      const mediaHit = url.pathname.match(/^\/media\/([0-9a-f]{16,})$/i);
      if (mediaHit && req.method === 'GET') {
        // Cross-site embed guard. A top-level navigation (opening "↗ original" in a new
        // tab) sends Sec-Fetch-Site none/same-origin/same-site; only an off-site page
        // embedding this URL (`<img src=…>`) sends 'cross-site'. Refuse that so private
        // media can't be pulled into a third-party page riding the cached auth.
        if ((req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Cross-site request refused.'); return;
        }
        let sdb = null;
        try {
          sdb = openSignalDb();
          const { buf, row } = decryptByHash(sdb, mediaHit[1]);
          const ct = String(row.contentType || 'application/octet-stream');
          const lc = ct.toLowerCase();
          // INLINE ONLY for types the browser renders inertly. contentType is chosen by
          // the Signal SENDER, so an attacker-picked `text/html` or `image/svg+xml` opened
          // inline would run script on THIS origin with the logged-in session (stored XSS,
          // full same-origin read/write). Positive allowlist (no text/*, no svg/xml) +
          // nosniff (no MIME-sniffing a spoofed type up to HTML) + CSP sandbox (no script
          // even if one slips the allowlist). Everything else downloads. See the
          // 2026-08-23 stored-XSS entry in docs/ENGINEERING-LOG.md.
          const INLINE_OK = new Set([
            'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
            'image/heic', 'image/heif',
            'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/webm',
            'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
            'application/pdf',
          ]);
          const inline = INLINE_OK.has(lc);
          const EXTS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
            'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'video/mp4': '.mp4', 'video/webm': '.webm',
            'video/quicktime': '.mov', 'application/pdf': '.pdf' };
          const name = `original-${mediaHit[1].slice(0, 12)}${EXTS[lc] || ''}`;
          res.writeHead(200, {
            'Content-Type': ct,
            'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': 'sandbox',
            'Cache-Control': 'private, no-store',
          });
          res.end(buf);
        } catch {
          send(404, page('Not found', '<div class="back"><a href="/">&larr; back</a></div><p>That attachment could not be opened — it may not be downloaded to this device, or is no longer on disk.</p>'));
        } finally {
          try { if (sdb) sdb.close(); } catch { /* already closed */ }
        }
        return;
      }

      if (url.pathname === '/') { send(200, indexPage()); return; }

      if (url.pathname === '/me') { send(200, mePage()); return; }

      if (url.pathname === '/tasks') { send(200, tasksPage()); return; }
      // Live due-date translation for the To do form: "monday" -> "2026-08-10".
      if (url.pathname === '/tasks/parse-date') {
        sendJson(200, { date: parseDeadline(url.searchParams.get('q'), new Date()) });
        return;
      }
      if (url.pathname.startsWith('/tasks/') && req.method === 'POST') {
        // Same CSRF guard as /actions/run: allow same-origin and direct curl
        // (which sends no Sec-Fetch-Site), refuse anything cross-site.
        if (!firstPartyOnly(req)) { send(403, page('Forbidden', '<p>Cross-site request refused.</p>')); return; }
        const action = url.pathname.slice('/tasks/'.length);
        readBody(req, (raw) => {
          let cdb = null;
          try {
            const p = new URLSearchParams(raw);
            cdb = openCrmDb();
            // `delete` IS a dismissal: the row (and its dedupe key) must survive so a
            // re-ingest of the same ledger can never re-draft a task Nathan removed.
            const STATUS_ACTIONS = { accept: 'active', dismiss: 'dismissed', done: 'done', reopen: 'active', delete: 'dismissed' };
            if (action === 'add') {
              if (!p.get('title')) { send(400, page('Bad request', '<p>A title is required.</p>')); return; }
              TASKS.addManual(cdb, { title: p.get('title'), deadline: parseDeadline(p.get('deadline'), new Date()), importance: p.get('importance') });
            } else if (STATUS_ACTIONS[action] || action === 'edit') {
              const id = p.get('id');
              if (!/^\d+$/.test(String(id))) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
              if (action === 'edit') {
                const title = (p.get('title') || '').trim();
                if (!title) { send(400, page('Bad request', '<p>A title is required.</p>')); return; }
                TASKS.updateTask(cdb, id, {
                  title, description: p.get('description'),
                  deadline: parseDeadline(p.get('deadline'), new Date()),
                  importance: p.get('importance'),
                });
              } else {
                TASKS.setStatus(cdb, id, STATUS_ACTIONS[action]);
              }
            } else {
              send(404, page('Not found', '<p>Not found.</p>')); return;
            }
            // A background toggle (done/reopen) sends X-Requested-With: fetch and
            // wants no navigation — answer 204 so the card restyles in place.
            if (req.headers['x-requested-with'] === 'fetch') { res.writeHead(204); res.end(); }
            else { res.writeHead(303, { Location: '/tasks' }); res.end(); }
          } catch (e) {
            try { send(500, page('Error', `<p class="bad">${esc(String(e.message).slice(0, 200))}</p>`)); } catch { /* sent */ }
          } finally {
            if (cdb) try { cdb.close(); } catch { /* closed */ }
          }
        });
        return;
      }
      if (url.pathname === '/status' || url.pathname === '/admin') { send(200, statusPage()); return; }
      if (url.pathname === '/runs' || url.pathname === '/admin/runs') { send(200, runsPage()); return; }
      const rdiff = url.pathname.match(/^\/runs\/([^/]+)\/diff\/([^/]+)$/);
      if (rdiff) {
        const id = decodeURIComponent(rdiff[1]);
        const slug = decodeURIComponent(rdiff[2]);
        if (!isSafeRunId(id) || !isSafeSlug(slug)) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
        // ?chunk=<n> selects one chunk's own commit pair; absent = whole run.
        const rawChunk = url.searchParams.get('chunk');
        const chunkIdx = rawChunk != null && /^\d{1,4}$/.test(rawChunk) ? Number(rawChunk) : null;
        const html = diffPage(id, slug, chunkIdx);
        if (!html) { send(404, page('Not found', '<div class="back"><a href="/runs">&larr; Runs</a></div><p>No such run (or it has no snapshots to diff).</p>')); return; }
        send(200, html);
        return;
      }
      const rd = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (rd) {
        const id = decodeURIComponent(rd[1]);
        if (!isSafeRunId(id)) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
        const html = runDetailPage(id);
        if (!html) { send(404, page('Not found', '<div class="back"><a href="/runs">&larr; Runs</a></div><p>No such run.</p>')); return; }
        send(200, html);
        return;
      }

      // Launch a pipeline job (sweep / deep-sweep / ingest / todo) from the pipeline desk.
      // The desk is one <form>: `job` is the kind, or "<kind>:<slug>" for a row's
      // own trigger; `who` carries every checked roster slug; `deep` / `plan` are
      // per-kind modifiers.
      if (url.pathname === '/admin/jobs' && req.method === 'POST') {
        if (!firstPartyOnly(req)) { send(403, page('Forbidden', '<p>Cross-site request refused.</p>')); return; }
        readBody(req, (body) => {
          try {
            const p = new URLSearchParams(body);
            const jobVal = p.get('job') || '';
            const colon = jobVal.indexOf(':');
            let kind = colon === -1 ? jobVal : jobVal.slice(0, colon);
            // The Deep-sweep dial posts its own value; unfold it into sweep+deep.
            let deep = false;
            if (kind === 'deep-sweep') { kind = 'sweep'; deep = true; }
            else if (kind === 'sweep') deep = p.get('deep') != null;
            const slugs = (colon === -1 ? p.getAll('who') : [jobVal.slice(colon + 1)]).filter(isSafeSlug);
            const plan = kind === 'ingest' && p.get('plan') != null;
            const r = startJob({ kind, slugs, deep, plan });
            if (!r.ok) { send(409, page('Busy', `<div class="back"><a href="/admin/jobs/current">&larr; current job</a></div><p class="bad">${esc(r.error)}</p>`)); return; }
            res.writeHead(303, { Location: '/admin/jobs/current' });
            res.end();
          } catch {
            try { send(400, page('Bad request', '<p>Bad request.</p>')); } catch { /* sent */ }
          }
        });
        return;
      }
      // Enable/disable one of the periodic jobs (sweep/deep-sweep/ingest/todo). A
      // toggle only pauses the AUTOMATIC schedule — hand-started UI runs pass
      // --force and always proceed. No-JS friendly: a tiny form per switch.
      if (url.pathname === '/admin/toggle' && req.method === 'POST') {
        if (!firstPartyOnly(req)) { send(403, page('Forbidden', '<p>Cross-site request refused.</p>')); return; }
        readBody(req, (body) => {
          try {
            const p = new URLSearchParams(body);
            const job = p.get('job') || p.get('toggle') || '';
            if (!RUN_TOGGLES.JOBS.includes(job)) { send(400, page('Bad request', '<p>Unknown job.</p>')); return; }
            // The per-dial switch is a single button that posts a bare `toggle=<job>`
            // → flip the current state. An explicit `enabled` (any two-state caller)
            // still wins.
            const enabled = p.has('enabled')
              ? (p.get('enabled') === '1' || p.get('enabled') === 'true')
              : !RUN_TOGGLES.isEnabled(job);
            RUN_TOGGLES.setToggle(job, enabled);
            res.writeHead(303, { Location: '/admin' });
            res.end();
          } catch {
            try { send(400, page('Bad request', '<p>Bad request.</p>')); } catch { /* sent */ }
          }
        });
        return;
      }
      // Pick the model for a paid job (ingest/todo). The card's <select> is named
      // model:<job> and the submit button carries setmodel=<job>. An empty model
      // clears the override (back to the pipeline default). setModel validates the
      // id against the curated list and throws on anything else → 400.
      if (url.pathname === '/admin/model' && req.method === 'POST') {
        if (!firstPartyOnly(req)) { send(403, page('Forbidden', '<p>Cross-site request refused.</p>')); return; }
        readBody(req, (body) => {
          try {
            const p = new URLSearchParams(body);
            const job = p.get('setmodel') || p.get('job') || '';
            if (!RUN_MODELS.JOBS.includes(job)) { send(400, page('Bad request', '<p>Unknown job.</p>')); return; }
            const model = p.get(`model:${job}`) || p.get('model') || '';
            RUN_MODELS.setModel(job, model);
            res.writeHead(303, { Location: '/admin' });
            res.end();
          } catch {
            try { send(400, page('Bad request', '<p>Unknown model.</p>')); } catch { /* sent */ }
          }
        });
        return;
      }
      if (url.pathname === '/admin/jobs/status.json') { sendJson(200, { job: jobToView() }); return; }
      // /admin/jobs, /admin/jobs/current, /admin/jobs/<id> all show the one job.
      if (url.pathname === '/admin/jobs' || url.pathname.startsWith('/admin/jobs/')) { send(200, jobPage()); return; }

      const mm = url.pathname.match(/^\/m\/(\d+)$/);
      if (mm) {
        const html = messagePage(Number(mm[1]));
        if (!html) { send(404, page('Not found', '<div class="back"><a href="/">&larr; All contacts</a></div><p>Message not in the archive (it may predate provenance tracking).</p>')); return; }
        send(200, html);
        return;
      }
      // A range citation: `/m/<start>-<end>`, optionally with a `#m<primary>`
      // fragment the browser resolves. Cannot collide with /m/<id> above — the
      // hyphen makes that pattern fail — but it must be tried before the 404.
      const ms = url.pathname.match(/^\/m\/(\d+)-(\d+)$/);
      if (ms) {
        const html = spanPage(Number(ms[1]), Number(ms[2]));
        if (!html) { send(404, page('Not found', '<div class="back"><a href="/">&larr; All contacts</a></div><p>That range does not start at a message in the archive.</p>')); return; }
        send(200, html);
        return;
      }
      // Must precede /c/<slug>, whose pattern would otherwise not match but
      // whose 404 would. isSafeSlug is the path-traversal guard: the slug goes
      // into a git pathspec, so `../` must never reach it.
      const cl = url.pathname.match(/^\/c\/([^/]+)\/ledger\/([0-9a-fA-F]{7,40})$/);
      if (cl) {
        const slug = decodeURIComponent(cl[1]);
        if (!isSafeSlug(slug)) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
        const html = ledgerPage(slug, cl[2]);
        if (!html) { send(404, page('Not found', `<div class="back"><a href="/c/${encodeURIComponent(slug)}/history">&larr; history</a></div><p>No ledger captured at that commit.</p>`)); return; }
        send(200, html);
        return;
      }
      // Save a set of manual edits from the profile page (sections + fields),
      // as one JSON POST → one 'manual' run. The page's own JS is the client.
      const cf = url.pathname.match(/^\/c\/([^/]+)\/edit$/);
      if (cf && req.method === 'POST') {
        const slug = decodeURIComponent(cf[1]);
        if (!isSafeSlug(slug)) { sendJson(400, { ok: false, error: 'bad request' }); return; }
        if (!firstPartyOnly(req)) { sendJson(403, { ok: false, error: 'cross-site request refused' }); return; }
        // 512 KB: a save can carry several whole sections (the Timeline included).
        readBody(req, (raw2) => {
          try {
            let payload;
            try { payload = JSON.parse(raw2); } catch { sendJson(400, { ok: false, error: 'bad JSON' }); return; }
            const r = applyManualEdit(slug, payload || {});
            if (!r.ok) { sendJson(r.status, { ok: false, error: r.error }); return; }
            sendJson(200, { ok: true, changed: r.changed });
          } catch (e) {
            try { sendJson(500, { ok: false, error: String(e.message).slice(0, 200) }); } catch { /* sent */ }
          }
        }, 512_000);
        return;
      }
      // Render one unit's Markdown for the profile page's in-place editor —
      // closing an editor swaps in exactly what a reload would show.
      if (url.pathname === '/render' && req.method === 'POST') {
        if (!firstPartyOnly(req)) { sendJson(403, { ok: false, error: 'cross-site request refused' }); return; }
        readBody(req, (raw2) => {
          try {
            let payload;
            try { payload = JSON.parse(raw2); } catch { sendJson(400, { ok: false, error: 'bad JSON' }); return; }
            const text = payload && typeof payload.text === 'string' ? payload.text : null;
            if (text === null || text.length > 200_000) { sendJson(400, { ok: false, error: 'bad text' }); return; }
            const dates = msgDates();
            try { sendJson(200, { ok: true, html: renderProfile(text, { dateFor: dates.dateFor, now: Date.now() }) }); }
            finally { dates.close(); }
          } catch (e) {
            try { sendJson(500, { ok: false, error: String(e.message).slice(0, 200) }); } catch { /* sent */ }
          }
        }, 512_000);
        return;
      }
      // A contact's display name is auto-derived from their Signal nickname
      // (lib/signal-names) and is not editable here — the /rename route was removed.
      const ch = url.pathname.match(/^\/c\/([^/]+)\/history$/);
      if (ch) {
        const slug = decodeURIComponent(ch[1]);
        if (!isSafeSlug(slug)) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
        const html = historyPage(slug);
        if (!html) { send(404, page('Not found', '<div class="back"><a href="/">&larr; All contacts</a></div><p>No history for this contact.</p>')); return; }
        send(200, html);
        return;
      }
      // Nickname mutations from the profile's identity block. One JSON POST per
      // action, mirroring /c/<slug>/edit's auth/body/JSON handling; the response
      // carries the re-rendered .nn block so the client swaps it in. Must precede
      // the generic /c/<slug> GET below (whose pattern would not match anyway, but
      // whose 404 would if this fell through).
      // People-tab suggestions inbox: id-based nickname actions (no per-contact slug
      // in the path). Re-renders the whole #nnInbox block for the client to swap.
      const nib = url.pathname.match(/^\/nick\/(assign|confirm|dismiss)$/);
      if (nib && req.method === 'POST') {
        if (!firstPartyOnly(req)) { sendJson(403, { ok: false, error: 'cross-site request refused' }); return; }
        readBody(req, (raw2) => {
          try {
            let payload;
            try { payload = JSON.parse(raw2 || '{}'); } catch { sendJson(400, { ok: false, error: 'bad JSON' }); return; }
            const r = applyNickInbox(nib[1], payload || {});
            if (!r.ok) { sendJson(r.status || 400, { ok: false, error: r.error }); return; }
            sendJson(200, { ok: true, html: renderInbox() });
          } catch (e) {
            try { sendJson(500, { ok: false, error: String(e.message).slice(0, 200) }); } catch { /* sent */ }
          }
        });
        return;
      }

      const cnk = url.pathname.match(/^\/c\/([^/]+)\/nick\/(add|confirm|edit|dismiss)$/);
      if (cnk && req.method === 'POST') {
        const slug = decodeURIComponent(cnk[1]);
        const action = cnk[2];
        if (!isSafeSlug(slug)) { sendJson(400, { ok: false, error: 'bad request' }); return; }
        if (!firstPartyOnly(req)) { sendJson(403, { ok: false, error: 'cross-site request refused' }); return; }
        readBody(req, (raw2) => {
          try {
            let payload;
            try { payload = JSON.parse(raw2 || '{}'); } catch { sendJson(400, { ok: false, error: 'bad JSON' }); return; }
            const r = applyNickEdit(slug, action, payload || {});
            if (!r.ok) { sendJson(r.status || 400, { ok: false, error: r.error }); return; }
            sendJson(200, { ok: true, html: renderNicks(slug) });
          } catch (e) {
            try { sendJson(500, { ok: false, error: String(e.message).slice(0, 200) }); } catch { /* sent */ }
          }
        });
        return;
      }
      // Relationship graph: READ (diagram + citations) and CORRECT (relink one
      // citation to a different person). Sits before the generic /c/<slug> match
      // below so 'graph' is never mistaken for a contact slug.
      // View filters (default off): ?mine=0 hides Nathan's own mentions; ?dm=0 hides
      // naming the other party of your own 1:1.
      const graphOpts = { hideMine: url.searchParams.get('mine') === '0', hideDm: url.searchParams.get('dm') === '0' };
      if (url.pathname === '/graph') { send(200, graphPage(graphOpts)); return; }
      if (url.pathname === '/graph/edge') {
        const from = url.searchParams.get('from') || '';
        const to = url.searchParams.get('to') || '';
        if (!isSafeSlug(from) || !isSafeSlug(to)) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
        send(200, edgePage(from, to, graphOpts));
        return;
      }
      if (url.pathname === '/graph/reassign' && req.method === 'POST') {
        if (!firstPartyOnly(req)) { send(403, page('Forbidden', '<p>Cross-site request refused.</p>')); return; }
        readBody(req, (body) => {
          try {
            const p = new URLSearchParams(body);
            const from = p.get('from') || '';
            const origTo = p.get('orig_to') || '';
            const newTo = p.get('new_to') || '';
            const srcMsg = Number(p.get('src_msg'));
            // new_to === orig_to is a no-op that would delete the citation; new_to ===
            // from would make a self-edge the rebuild drops. Reject both.
            if (!isSafeSlug(from) || !isSafeSlug(origTo) || !isSafeSlug(newTo)
              || !Number.isInteger(srcMsg) || srcMsg <= 0
              || newTo === origTo || newTo === from) {
              send(400, page('Bad request', '<p>Bad request.</p>'));
              return;
            }
            const rdb = openCrmDb();
            try {
              rdb.exec('BEGIN IMMEDIATE');
              try {
                // Only act if a live scan citation actually sits on the original edge.
                // Absent it (a replay, a stale form, or a non-scan row) this is a no-op
                // so a double-submit can never delete the just-moved citation.
                const live = rdb.prepare("SELECT 1 FROM mentions WHERE from_slug=? AND to_slug=? AND kind='mentioned' AND src_msg=? AND source='scan'")
                  .get(from, origTo, srcMsg);
                if (live) {
                  // Persist the correction so the nightly rebuild honors it too...
                  recordReassign(rdb, { src_msg: srcMsg, from_slug: from, orig_to: origTo, new_to: newTo, created_at: Date.now() });
                  // ...and move the live row now, so the citation is off the old edge
                  // before the next sweep. UNIQUE(from_slug,to_slug,kind,src_msg) means
                  // the target slot may already hold a duplicate scan citation -- clear
                  // only that (scoped to source='scan'), never a hand-owned model row.
                  rdb.prepare("DELETE FROM mentions WHERE from_slug=? AND to_slug=? AND kind='mentioned' AND src_msg=? AND source='scan'")
                    .run(from, newTo, srcMsg);
                  rdb.prepare("UPDATE mentions SET to_slug=? WHERE from_slug=? AND to_slug=? AND kind='mentioned' AND src_msg=? AND source='scan'")
                    .run(newTo, from, origTo, srcMsg);
                }
                rdb.exec('COMMIT');
              } catch (e) {
                rdb.exec('ROLLBACK');
                throw e;
              }
            } finally {
              try { rdb.close(); } catch { /* already closed */ }
            }
            res.writeHead(303, { Location: `/graph/edge?from=${encodeURIComponent(from)}&to=${encodeURIComponent(origTo)}` });
            res.end();
          } catch {
            try { send(400, page('Bad request', '<p>Bad request.</p>')); } catch { /* sent */ }
          }
        });
        return;
      }
      const m = url.pathname.match(/^\/c\/([^/]+)$/);
      if (m) {
        const slug = decodeURIComponent(m[1]);
        if (!isSafeSlug(slug)) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
        const html = profilePage(slug);
        if (!html) { send(404, page('Not found', '<div class="back"><a href="/">&larr; All contacts</a></div><p>No such contact.</p>')); return; }
        send(200, html);
        return;
      }
      send(404, page('Not found', '<div class="back"><a href="/">&larr; All contacts</a></div><p>Not found.</p>'));
    } catch (e) {
      try { send(400, page('Bad request', '<p>Bad request.</p>')); } catch { /* headers already sent */ }
    }
  });
  server.listen(WEB_PORT, '127.0.0.1', () => {
    console.log(`Personal CRM web app: http://localhost:${WEB_PORT}  (user: ${WEB_USER})`);
  });
}

start();
