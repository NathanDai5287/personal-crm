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
  TRACKED, REFRESH_STATE, LOGS_DIR, GITDIR, MERGE_MODEL,
} = require('../lib/config');
const { openCrmDb, openSignalDb } = require('../lib/signal-db');
const { resolveSources, buildMessageQuery, buildArchiveQuery } = require('../lib/sources');
const { validateCitations } = require('../lib/archive');
const TASKS = require('../lib/tasks');
const { STYLE: BINDERY_CSS, FONTS, THEME_INIT, THEME_JS } = require('../lib/view/shell');
const { render, raw } = require('../lib/view/h');
const V = require('../lib/view/pages');
const { renderProfile, inline: mdInline } = require('../lib/view/markdown');
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
  console.log(`\n  No password set — generated one and saved it to:\n    ${WEB_PASSWORD_FILE}\n  Username: ${WEB_USER}\n  Password: ${generated}\n`);
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

// ---------------------------------------------------------------------------
// Markdown rendering (compact, tuned for the profile format)
// ---------------------------------------------------------------------------
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  const GROUP = String.raw`⟨\s*m\d+(?:-m\d+)?(?:\s+@m\d+)?\s*⟩`;
  const ONE = /⟨\s*m(\d+)(?:-m(\d+))?(?:\s+@m(\d+))?\s*⟩/g;
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
      links.push(`<a href="${href}" title="source ${label}${primary ? `, key line m${primary}` : ''}">${n}</a>`);
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
// MONTH PRECISION IS LEGAL. prompts/merge.md permits `**YYYY-MM**` when only the
// month is known ("sometime in August") rather than stamping a false precise day —
// and real profiles use it (nigesh carries `**2027-02**`). Requiring YYYY-MM-DD
// here silently demoted those to undated and left the `**…**` markup in the text.
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
    const m = t.match(/^[-*]\s+(?:\*\*(\d{4}-\d{2}(?:-\d{2})?)\*\*\s*)?(.+)$/);
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
  const today = new Date().toISOString().slice(0, 10);
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

// Toggling a task done/reopen posts in the background and restyles the card in
// place — no full page reload. The X-Requested-With header tells the POST handler
// to answer 204 instead of the 303 a form submit gets. The plate counts are
// nudged to match; a failed request reverts the checkbox.
const TASKS_TOGGLE_JS = `<script>(function(){
  function adj(id,d){var el=document.getElementById(id);if(!el)return;var n=parseInt(el.textContent,10)||0;el.textContent=Math.max(0,n+d);}
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
        if(card)card.classList.toggle('done',nowDone);
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

function tasksPage(editId = null) {
  let cdb;
  try { cdb = openCrmDb(); } catch { return page('To do — personal-crm', '<p class="bad">archive unavailable</p>', '/tasks'); }
  let drafts = [];
  let active = [];
  let done = [];
  let counts = { draft: 0, active: 0, done: 0, dismissed: 0 };
  let editing = null;
  try {
    // Drafts are ROWS, written by scripts/crm-tasks.js during an ingest run — not
    // derived from the profile. Deriving them from `## Talking points` is what
    // filled this list with conversation topics instead of commitments.
    drafts = TASKS.listByStatus(cdb, 'draft');
    active = TASKS.listByStatus(cdb, 'active');
    done = TASKS.listByStatus(cdb, 'done');
    counts = TASKS.counts(cdb);
    if (editId) editing = TASKS.getTask(cdb, editId);
  } finally {
    try { cdb.close(); } catch { /* closed */ }
  }
  // Shape the DB rows into what lib/view's tasks page expects: a display name, the
  // source-message id, and description Markdown pre-rendered to Bindery HTML so its
  // ⟨m…⟩ citations become slips.
  const shape = (t) => ({
    ...t,
    name: t.contact_name || t.slug,
    msgId: t.source_msg_id,
    probable: t.confidence === 'probable',
    descHtml: t.description ? mdInline(t.description) : '',
  });
  const data = {
    counts, editing, today: new Date().toISOString().slice(0, 10),
    active: active.map(shape), done: done.map(shape), drafts: drafts.map(shape),
  };
  return page('To do — personal-crm', render(V.tasks(data).body) + TASKS_TOGGLE_JS + TASKS_DATE_JS);
}


// Real contacts mapped to the shape lib/view's people/admin pages expect. Facts
// are the top talking points, rendered to HTML so their ⟨m…⟩ slips survive.
// `waiting` is archived-but-not-yet-ingested (id past the merge cursor); a
// contact with no cursor has their whole history waiting (a backfill).
function contactList() {
  const cdb = openCrmDb();
  try {
    const cursors = loadCursors();
    const held = new Map();
    for (const r of cdb.prepare("SELECT contact_slug slug, COUNT(*) n FROM messages WHERE contact_slug IS NOT NULL GROUP BY contact_slug").all()) {
      held.set(r.slug, r.n);
    }
    const past = cdb.prepare('SELECT COUNT(*) n FROM messages WHERE contact_slug = ? AND id > ?');
    const total = cdb.prepare('SELECT COUNT(*) n FROM messages WHERE contact_slug = ?');
    return listContacts().map((c) => {
      const hasCursor = Object.prototype.hasOwnProperty.call(cursors, c.slug);
      const cursor = hasCursor ? (cursors[c.slug] || 0) : null;
      const waiting = hasCursor ? past.get(c.slug, cursor).n : total.get(c.slug).n;
      const facts = c.talkingPoints.slice(0, 3).map((tp) => mdInline((tp.date ? `**${tp.date}** ` : '') + tp.text));
      return {
        slug: c.slug, name: c.name, rel: c.relationship, last: c.last,
        held: held.get(c.slug) || 0, waiting, cursor, facts,
        stamp: waiting > 0 ? `${waiting} waiting` : null, stampBlue: true,
      };
    });
  } finally {
    cdb.close();
  }
}

function indexPage() {
  return page('People — personal-crm', render(V.people(contactList()).body));
}

// Shared bubble renderer for both provenance views. Every bubble carries
// `id="m<rowid>"` so a URL fragment can address one — `/m/<start>-<end>#m<primary>`
// highlights the primary client-side, since the fragment never reaches the server.
// `hitId` is the server-known highlight (the single message of /m/<id>).
function msgBubbles(rows, hitId) {
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  return rows.map((m) => {
    const mine = /^nathan$/i.test(m.sender);
    const hit = m.id === hitId ? ' hit' : '';
    return `<div class="q ${mine ? 'me' : 'them'}${hit}" id="m${m.id}">` +
      `<span class="who">${esc(m.sender)} · ${esc(fmt(m.sent_at))}</span>${mdInline(m.body)}</div>`;
  }).join('');
}

// Scroll the highlighted bubble into view. A `#m<id>` fragment, if present and
// real, becomes the highlight; otherwise the server-marked `.hit` is used.
const SCROLL_TO_HIT = `<script>(function(){`
  + `var h=(location.hash||'').slice(1),t=h&&/^m\\d+$/.test(h)?document.getElementById(h):null;`
  + `if(t)t.classList.add('hit');else t=document.querySelector('.q.hit');`
  + `if(t)t.scrollIntoView({block:'center'});})();</script>`;

// Provenance view: one archived message, highlighted, with ±10 messages of
// context from the same conversation — resolved from crm.db's archive (not
// Signal's DB), so cited messages stay viewable even if Signal purges history.
function messagePage(id) {
  let cdb;
  try { cdb = openCrmDb(); } catch { return null; }
  try {
    let msg = null;
    try { msg = cdb.prepare('SELECT * FROM messages WHERE id = ?').get(id); } catch { /* archive table not created yet */ }
    if (!msg) return null;
    const before = msg.conv_id
      ? cdb.prepare('SELECT * FROM messages WHERE conv_id = ? AND (sent_at < ? OR (sent_at = ? AND id < ?)) ORDER BY sent_at DESC, id DESC LIMIT 10')
          .all(msg.conv_id, msg.sent_at, msg.sent_at, msg.id).reverse()
      : [];
    const after = msg.conv_id
      ? cdb.prepare('SELECT * FROM messages WHERE conv_id = ? AND (sent_at > ? OR (sent_at = ? AND id > ?)) ORDER BY sent_at ASC, id ASC LIMIT 10')
          .all(msg.conv_id, msg.sent_at, msg.sent_at, msg.id)
      : [];
    const backHref = msg.contact_slug ? `/c/${encodeURIComponent(msg.contact_slug)}` : '/';
    const body = `<div class="back"><a href="${backHref}">&larr; back</a></div>` +
      `<div class="profile"><h1>${esc(msg.conversation || 'Conversation')}</h1>` +
      `<p class="sub">source message <code>m${msg.id}</code>, shown in context</p>` +
      `<div class="charge">${msgBubbles([...before, msg, ...after], msg.id)}</div></div>` +
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
// mirrored) are normal rather than errors.
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
    const backHref = anchor.contact_slug ? `/c/${encodeURIComponent(anchor.contact_slug)}` : '/';
    const span = `m${start}&ndash;m${end}`;
    const body = `<div class="back"><a href="${backHref}">&larr; back</a></div>` +
      `<div class="profile"><h1>${esc(anchor.conversation || 'Conversation')}</h1>` +
      `<p class="sub">cited range <code>${span}</code> &middot; ` +
      `${rows.length} message${rows.length === 1 ? '' : 's'} in this conversation` +
      `${anchor.conv_id ? '' : ' (no conversation recorded for this row)'}</p>` +
      `<div class="charge">${msgBubbles(rows, null)}</div></div>` +
      SCROLL_TO_HIT;
    return page(`m${start}-m${end} — ${anchor.conversation || 'range'}`, body, '/');
  } finally {
    try { cdb.close(); } catch { /* already closed */ }
  }
}

function profilePage(slug) {
  const file = path.posix.join(CONTACTS_DIR, `${slug}.md`);
  let md;
  try { md = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const titleLine = md.split(/\r?\n/).find((l) => l.startsWith('# '));
  const name = titleLine ? titleLine.slice(2).trim() : slug;
  const body = `<div class="back"><a href="/">&larr; All people</a>`
    + ` &middot; <a href="/c/${encodeURIComponent(slug)}/history">History &rarr;</a></div>`
    + `<div class="profile">${renderProfile(md)}</div>`;
  return page(name, body, '/');
}

// ---- rename a contact's display name ---------------------------------------
// The roster name is the profile's `# ` title line (listContacts reads it), so a
// rename is a one-line rewrite of data/contacts/<slug>.md. The slug, archive
// (crm.db contact_slug), cursors, and git history are all keyed off the slug and
// are deliberately untouched — this changes what you SEE, not the identity.
function renamePage(slug) {
  const file = path.posix.join(CONTACTS_DIR, `${slug}.md`);
  let md;
  try { md = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const titleLine = md.split(/\r?\n/).find((l) => l.startsWith('# '));
  const name = titleLine ? titleLine.slice(2).trim() : slug;
  const v = V.rename({ slug, name });
  return page(v.title, render(v.body));
}

function renameContact(slug, newName) {
  const file = path.posix.join(CONTACTS_DIR, `${slug}.md`);
  let md;
  try { md = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, error: 'no such contact' }; }
  const lines = md.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith('# '));
  if (idx === -1) lines.unshift(`# ${newName}`, '');
  else lines[idx] = `# ${newName}`;
  fs.writeFileSync(file, lines.join('\n'));
  // Best-effort commit to the isolated history, so the rename is attributed and
  // future diffs stay clean. Non-fatal: the file is already written and served,
  // and the next pipeline run snapshots it regardless.
  const relPath = `data/contacts/${slug}.md`;
  try {
    execFileSync('git', ['--git-dir', GITDIR, '--work-tree', ROOT, 'add', '--', relPath], { cwd: ROOT, timeout: 15_000 });
    execFileSync('git', ['--git-dir', GITDIR, '--work-tree', ROOT, 'commit', '-m', `rename ${slug} → ${newName}`], { cwd: ROOT, timeout: 15_000 });
  } catch { /* uncommitted rename still shows */ }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Screen B — /status: what would run right now, per tracked contact
// ---------------------------------------------------------------------------
function loadTrackedSlugs() {
  try { return JSON.parse(fs.readFileSync(TRACKED, 'utf8')).slugs || []; } catch { return []; }
}
function loadCursors() {
  try {
    const raw = JSON.parse(fs.readFileSync(REFRESH_STATE, 'utf8'));
    if (raw && raw.cursors && typeof raw.cursors === 'object') return raw.cursors;
  } catch { /* no state yet */ }
  return {};
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
function fmtWhen(ts) {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
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

function dial(label, cadence, sinceMs, intervalMs) {
  // Never run yet: an empty ring, not a full one — a null `sinceMs` otherwise
  // read as "a whole interval elapsed" and drew a misleading full arc.
  if (sinceMs == null) {
    return { label, cadence, since: 'not yet run', center: '—', centerSub: 'never', fraction: 0, overdue: false };
  }
  const remaining = intervalMs - sinceMs;
  const overdue = remaining < 0;
  return {
    label, cadence,
    since: `${fmtAgo(sinceMs)} ago`,
    center: overdue ? `+${fmtAgo(-remaining)}` : fmtAgo(remaining),
    centerSub: overdue ? 'overdue' : 'til next',
    fraction: sinceMs / intervalMs, overdue,
  };
}

function adminData() {
  const now = Date.now();
  const roster = contactList();
  let kept = 0;
  let span = '—';
  const cdb = openCrmDb();
  try {
    const r = cdb.prepare('SELECT COUNT(*) n, MIN(sent_at) a, MAX(sent_at) b FROM messages').get();
    kept = r.n || 0;
    if (r.a) span = `${new Date(r.a).toISOString().slice(0, 10)} → ${new Date(r.b).toISOString().slice(0, 10)}`;
  } finally {
    cdb.close();
  }
  const arch = loadArchiveState();
  const sweepMs = arch.ranAt ? now - arch.ranAt : null;
  const deepMs = arch.deepRanAt ? now - arch.deepRanAt : null;
  const runs = loadRuns();
  const ingestMs = runs.length ? now - runs[0].startedAt : null;
  const backupMs = backupAgeMs(now);
  const waiting = roster.reduce((s, x) => s + x.waiting, 0);
  const inPeople = roster.filter((x) => x.waiting > 0).length;
  const HOUR = 3600000;
  const health = {
    kept: kept.toLocaleString(), span, tracked: roster.length,
    stranded: '—', strandedSub: 'deep-sweep to verify',
    lastSweep: sweepMs == null ? '—' : fmtAgo(sweepMs), lastSweepSub: sweepMs == null ? 'never run' : 'ago · hourly',
    sweepStale: sweepMs != null && sweepMs > 90 * 60000,
    waiting: waiting.toLocaleString(), waitingSub: `in ${inPeople} ${inPeople === 1 ? 'person' : 'people'}`,
    backupAge: backupMs == null ? '—' : fmtAgo(backupMs), backupSub: 'off-machine', backupStale: backupMs != null && backupMs > 8 * DAY,
  };
  // A dial per scheduled job, named to match the Key — no vague "pipeline". Each
  // maps to a real registered task (tools/register-*.ps1): sweep is the hourly
  // archive copy; the deep sweep is a daily full re-walk; ingest and compact are
  // the two steps of the weekly Monday run, so they share its clock.
  const dials = [
    dial('Sweep', 'hourly', sweepMs, HOUR),
    dial('Deep sweep', 'daily', deepMs, DAY),
    dial('Ingest', 'weekly · Mondays', ingestMs, 7 * DAY),
    dial('Timeline', 'weekly · after ingest', ingestMs, 7 * DAY),
  ];
  return { health, roster, dials };
}

// Confirm modal for the job buttons. Replaces the browser confirm() with a
// Bindery slip that resolves and LISTS the exact people the run will touch:
// the checked roster names, or everyone if none are checked, or the single
// person for a row's own trigger. Approving submits the form with that button.
const JOB_MODAL_JS = `<script>(function(){
  var form=document.querySelector('form[action="/admin/jobs"]');
  if(!form)return;
  var ov=document.createElement('div');ov.className='modal';ov.hidden=true;
  ov.innerHTML='<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="mTitle">'
    +'<div class="modal-stamp" id="mStamp"></div>'
    +'<h2 class="modal-title" id="mTitle"></h2>'
    +'<div class="modal-meta" id="mMeta"></div>'
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
  function open(btn){
    pending=btn;
    var val=btn.value,i=val.indexOf(':');
    var kind=i===-1?val:val.slice(0,i),one=i===-1?null:val.slice(i+1);
    var deep=kind==='sweep'&&modOn('deep'),plan=kind==='ingest'&&modOn('plan');
    var everyone=false,who;
    if(one){who=[nameFor(one)];}
    else{
      var checked=boxes().filter(function(c){return c.checked;});
      if(checked.length){who=checked.map(function(c){return nameFor(c.value);});}
      else{everyone=true;who=boxes().map(function(c){return nameFor(c.value);});}
    }
    document.getElementById('mStamp').textContent=kind;
    document.getElementById('mTitle').textContent='Run '+kind+(deep?' · deep':'')+(plan?' · plan only':'');
    document.getElementById('mMeta').textContent=kind==='sweep'?'Free — copies messages into the archive, no model.':(plan?'Planning only — reads messages, no model, no writes.':'Calls the model.');
    document.getElementById('mWhoH').textContent=(everyone?'Everyone — ':'')+'will run on '+who.length+(who.length===1?' person':' people');
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
// compact each get a distinct chip) and which fields fill the shared columns —
// the numbers mean different things per kind, but the header labels stay generic
// and the note clarifies. `ok:false` renders the note in oxblood.
function rowForRun(r) {
  const t = fmtWhen(r.startedAt);
  const took = fmtMs(r.durationMs);
  if (r.kind === 'sweep') {
    return {
      t, kind: 'sweep',
      pass: r.deep ? 'deep' : 'hourly',
      scope: r.only || 'everyone',
      examined: String(r.seen ?? ''),
      held: `${r.inserted ?? 0} new`,
      took, ok: true,
      note: r.reuse ? 'rowid reuse detected' : `${r.inserted ?? 0} message(s) archived`,
    };
  }
  if (r.kind === 'compact') {
    return {
      t, kind: 'compact',
      pass: r.only ? 'timeline (one)' : 'timeline',
      scope: r.only || 'everyone',
      examined: String(r.scanned ?? ''),
      held: `${r.changed ?? 0} changed`,
      took, ok: true,
      note: `${r.summaries ?? 0} summary line(s)`,
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
    took, ok: failures === 0,
    note: failures
      ? `${failures} merge failure(s)`
      : ((r.warnings || []).length ? `${r.warnings.length} warning(s)` : `${r.chunksMerged ?? 0} chunk(s) ingested`),
  };
}

function runsPage() {
  const records = loadRuns()
    // Legacy records predate `kind`; they are all ingest runs.
    .map((r) => ({ ...r, kind: r.kind || 'ingest' }))
    // No-op sweeps (0 new messages) are recorded on disk but hidden here: the
    // hourly cadence would otherwise bury the weekly AI runs. Everything with
    // any effect — every ingest, every compact, every sweep that archived at
    // least one message — shows.
    .filter((r) => !(r.kind === 'sweep' && !r.inserted))
    .map(rowForRun);
  return page('Runs — personal-crm', render(V.runs(records).body));
}

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

  const warnHtml = (run.warnings || []).length
    ? `<h2>Warnings</h2><ul>${run.warnings.map((w) => `<li class="bad">${esc(w)}</li>`).join('')}</ul>`
    : '';

  // Which model wrote this run's output. Shown next to the diff links on
  // purpose: a profile diff is only interpretable if you know which model
  // produced it, and merge/compact can now be pointed at different models.
  const modelsHtml = run.models
    ? `<span class="sub"> · merge <code>${esc(run.models.merge || '?')}</code>` +
      (run.models.compact && run.models.compact !== run.models.merge
        ? ` · timeline <code>${esc(run.models.compact)}</code>` : '') + `</span>`
    : '';
  const cc = run.compactCitations;
  const compactCiteHtml = cc
    ? `<h2>Timeline citations</h2><p class="${cc.bad && cc.bad.length ? 'bad' : 'ok'}">` +
      (cc.bad && cc.bad.length
        ? `unresolvable ids in ${cc.bad.length} file(s): ${esc(cc.bad.join(' '))}`
        : `${cc.cited} cited ids across ${cc.files} files, all resolve`) + `</p>`
    : '';

  const body = `<div class="back"><a href="/runs">&larr; All runs</a></div>` +
    `<header class="top"><h1>Run ${esc(fmtWhen(run.startedAt))}</h1>` +
    `<span class="sub">${esc(runMode(run))} · ${fmtMs(run.durationMs)}</span>${modelsHtml}</header>` +
    `<h2>Steps</h2>${stepsHtml}${contactsHtml}${compactCiteHtml}${warnHtml}`;
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
      + `<a class="lid" href="/m/${m[2]}">m${m[2]}</a>`
      + `<span class="lts">${esc(m[1])}</span>`
      + `<span class="lwho">${esc(m[4])}</span>`
      + `<span class="lbody">${inline(m[5])}</span></div>`;
  }).join('');
  const counted = lines.filter((l) => /^\[[^\]]+\]\s+⟨m\d+⟩/.test(l)).length;

  // The profile's judged sections only — the Timeline is compaction's and would
  // bury the thing you are checking.
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
        + `<a href="/m/${h.chunk.from}">m${h.chunk.from}</a>…<a href="/m/${h.chunk.to}">m${h.chunk.to}</a>`
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

function diffPage(id, slug, chunkIdx) {
  let run;
  try { run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${id}.json`), 'utf8')); } catch { return null; }
  // A chunk index selects that chunk's own commit pair, so the diff shows what
  // ONE week-aligned merge did rather than everything the run touched.
  const chunk = chunkIdx != null && run.chunks ? run.chunks[chunkIdx] : null;
  const pre = (chunk && chunk.preSha) || run.preSha;
  const post = (chunk && chunk.postSha) || run.postSha;
  if (!pre || !post) return null;
  let diff;
  try {
    diff = execFileSync('git', ['--git-dir', GITDIR, 'diff', `${pre}..${post}`, '--', `data/contacts/${slug}.md`],
      { cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    diff = null;
  }
  const rendered = diff && diff.trim()
    ? diff.split('\n').map((l) => {
        const e = esc(l);
        if (l.startsWith('+++') || l.startsWith('---')) return `<span class="ctx">${e}</span>`;
        if (l.startsWith('@@')) return `<span class="hunk">${e}</span>`;
        if (l.startsWith('+')) return `<span class="add">${e}</span>`;
        if (l.startsWith('-')) return `<span class="del">${e}</span>`;
        return `<span class="ctx">${e}</span>`;
      }).join('\n')
    : '<span class="ctx">(no changes to this profile in this run)</span>';
  const body = `<div class="back"><a href="/runs/${encodeURIComponent(id)}">&larr; back to run</a></div>` +
    `<header class="top"><h1>${esc(slug)} — changes</h1><span class="sub">run ${esc(fmtWhen(run.startedAt))}</span></header>` +
    `<pre class="diff">${rendered}</pre>`;
  return page(`diff ${slug}`, body, '/runs');
}

// ---------------------------------------------------------------------------
// Screen C — the pipeline jobs: sweep / ingest / compact, launched from /admin
// ---------------------------------------------------------------------------
// In-memory single-job lock: one run at a time, so two launches can never
// interleave cursor state (a second launch while one runs is rejected with 409).
// A job runs a QUEUE of commands sequentially — one per selected person — and
// stops at the first failure rather than cascading model calls into a broken run.
let job = null;

const ARCHIVE_JS = path.join(ROOT, 'scripts', 'crm-archive.js');
const DAILY_JS = path.join(ROOT, 'scripts', 'crm-daily.js');
const COMPACT_JS = path.join(ROOT, 'scripts', 'crm-compact.js');

// A job spec → the argv(s) to run. An empty `slugs` means "everyone": sweep and
// compact each have a native all-people pass (run once), while ingest is
// per-contact by design (crm-daily --only), so it expands to every tracked slug.
//   sweep   → crm-archive.js  [--only <slug>] [--deep]     (free, no model)
//   ingest  → crm-daily.js    --only <slug>  [--dry-run]   (refresh + merge)
//   compact → crm-compact.js  --write [--slug <slug>]      (timeline summaries)
function jobCommands({ kind, slugs, deep, plan }) {
  if (kind === 'sweep') {
    const people = slugs.length ? slugs : [null];
    return people.map((s) => [ARCHIVE_JS, ...(s ? ['--only', s] : []), ...(deep ? ['--deep'] : [])]);
  }
  if (kind === 'ingest') {
    const people = slugs.length ? slugs : loadTrackedSlugs();
    return people.map((s) => [DAILY_JS, '--only', s, ...(plan ? ['--dry-run'] : [])]);
  }
  if (kind === 'compact') {
    const people = slugs.length ? slugs : [null];
    return people.map((s) => [COMPACT_JS, '--write', ...(s ? ['--slug', s] : [])]);
  }
  return null;
}

function startJob(spec) {
  if (job && job.running) return { ok: false, error: 'a run is already in progress' };
  if (!['sweep', 'ingest', 'compact'].includes(spec.kind)) return { ok: false, error: 'bad job kind' };
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
  const child = spawn(process.execPath, argv, { cwd: ROOT });
  const append = (d) => {
    job.buf += d.toString();
    if (job.buf.length > 400_000) job.buf = job.buf.slice(-400_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', (code) => {
    if (code) {
      job.exit = code;
      job.running = false;
      job.endedAt = Date.now();
      job.buf += `\n[step ${i + 1}/${cmds.length} exit ${code} — stopped]`;
      if (job.lock) { job.lock.release(); job.lock = null; }
      return;
    }
    job.done = i + 1;
    runQueue(cmds, i + 1);
  });
  child.on('error', (e) => {
    job.exit = -1;
    job.running = false;
    job.endedAt = Date.now();
    job.buf += `\n[spawn error: ${e.message}]`;
    if (job.lock) { job.lock.release(); job.lock = null; }
  });
}

// Shape the in-memory job for the V.job monitor component and status.json.
function jobToView() {
  if (!job) return null;
  const status = job.running ? 'running' : (job.exit ? 'failed' : 'done');
  const step = job.total > 1
    ? (job.running ? `person ${job.done + 1} of ${job.total}` : `${job.done} of ${job.total} done`)
    : (job.running ? 'running' : status);
  return {
    id: job.id,
    kind: job.kind[0].toUpperCase() + job.kind.slice(1) + (job.deep ? ' · deep' : '') + (job.plan ? ' · plan' : ''),
    scope: job.scope,
    status,
    startedAt: new Date(job.startedAt).toISOString().slice(11, 19) + ' UTC',
    elapsed: fmtMs((job.endedAt || Date.now()) - job.startedAt),
    step,
    model: job.kind === 'sweep' ? 'no model' : MERGE_MODEL,
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
        if(d.job.status==='running'){setTimeout(tick,1500);}else{location.reload();}
      }).catch(function(){setTimeout(tick,2500);});
    }
    setTimeout(tick,1200);
  })();</script>`;
  return page(`${j.kind} — job ${j.id}`, render(V.job(j).body) + poll);
}

function readBody(req, cb) {
  let buf = '';
  let over = false;
  req.on('data', (d) => {
    buf += d.toString();
    if (buf.length > 64_000) { over = true; req.destroy(); }
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
    if (!authOk(req.headers.authorization, WEB_USER, PASSWORD)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Personal CRM", charset="UTF-8"' });
      res.end('Authentication required');
      return;
    }
    const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
    const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    // A malformed request must never kill the server: `new URL` throws on
    // bogus absolute-form targets and decodeURIComponent throws on bad
    // percent-encoding (e.g. /c/%zz) — both were uncaught process crashes.
    try {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/') { send(200, indexPage()); return; }

      if (url.pathname === '/tasks') {
        const ed = url.searchParams.get('edit');
        send(200, tasksPage(ed && /^\d+$/.test(ed) ? Number(ed) : null));
        return;
      }
      // Live due-date translation for the To do form: "monday" -> "2026-08-10".
      if (url.pathname === '/tasks/parse-date') {
        sendJson(200, { date: parseDeadline(url.searchParams.get('q'), new Date()) });
        return;
      }
      if (url.pathname.startsWith('/tasks/') && req.method === 'POST') {
        // Same CSRF guard as /actions/run: allow same-origin and direct curl
        // (which sends no Sec-Fetch-Site), refuse anything cross-site.
        const sfs = req.headers['sec-fetch-site'];
        if (sfs && sfs !== 'same-origin' && sfs !== 'none') { send(403, page('Forbidden', '<p>Cross-site request refused.</p>')); return; }
        const action = url.pathname.slice('/tasks/'.length);
        readBody(req, (raw) => {
          let cdb = null;
          try {
            const p = new URLSearchParams(raw);
            cdb = openCrmDb();
            const STATUS_ACTIONS = { accept: 'active', dismiss: 'dismissed', done: 'done', reopen: 'active' };
            if (action === 'add') {
              if (!p.get('title')) { send(400, page('Bad request', '<p>A title is required.</p>')); return; }
              TASKS.addManual(cdb, { title: p.get('title'), deadline: parseDeadline(p.get('deadline'), new Date()), importance: p.get('importance') });
            } else if (STATUS_ACTIONS[action] || action === 'edit') {
              const id = p.get('id');
              if (!/^\d+$/.test(String(id))) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
              if (action === 'edit') {
                TASKS.updateTask(cdb, id, {
                  title: p.get('title'), description: p.get('description'),
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

      // Launch a pipeline job (sweep / ingest / compact) from the pipeline desk.
      // The desk is one <form>: `job` is the kind, or "<kind>:<slug>" for a row's
      // own trigger; `who` carries every checked roster slug; `deep` / `plan` are
      // per-kind modifiers.
      if (url.pathname === '/admin/jobs' && req.method === 'POST') {
        const sfs = req.headers['sec-fetch-site'];
        if (sfs && sfs !== 'same-origin' && sfs !== 'none') { send(403, page('Forbidden', '<p>Cross-site request refused.</p>')); return; }
        readBody(req, (body) => {
          try {
            const p = new URLSearchParams(body);
            const jobVal = p.get('job') || '';
            const colon = jobVal.indexOf(':');
            const kind = colon === -1 ? jobVal : jobVal.slice(0, colon);
            const slugs = (colon === -1 ? p.getAll('who') : [jobVal.slice(colon + 1)]).filter(isSafeSlug);
            const deep = kind === 'sweep' && p.get('deep') != null;
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
      // Rename a contact's display name. GET renders the form, POST applies it.
      const cn = url.pathname.match(/^\/c\/([^/]+)\/rename$/);
      if (cn) {
        const slug = decodeURIComponent(cn[1]);
        if (!isSafeSlug(slug)) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
        if (req.method === 'POST') {
          const sfs = req.headers['sec-fetch-site'];
          if (sfs && sfs !== 'same-origin' && sfs !== 'none') { send(403, page('Forbidden', '<p>Cross-site request refused.</p>')); return; }
          readBody(req, (raw2) => {
            try {
              const name = String(new URLSearchParams(raw2).get('name') || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
              if (!name) { send(400, page('Bad request', '<div class="back"><a href="/admin">&larr; pipeline</a></div><p>A name is required.</p>')); return; }
              const r = renameContact(slug, name);
              if (!r.ok) { send(404, page('Not found', `<p>${esc(r.error)}</p>`)); return; }
              res.writeHead(303, { Location: '/admin' });
              res.end();
            } catch (e) {
              try { send(500, page('Error', `<p class="bad">${esc(String(e.message).slice(0, 200))}</p>`)); } catch { /* sent */ }
            }
          });
          return;
        }
        const html = renamePage(slug);
        if (!html) { send(404, page('Not found', '<div class="back"><a href="/admin">&larr; pipeline</a></div><p>No such contact.</p>')); return; }
        send(200, html);
        return;
      }
      const ch = url.pathname.match(/^\/c\/([^/]+)\/history$/);
      if (ch) {
        const slug = decodeURIComponent(ch[1]);
        if (!isSafeSlug(slug)) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
        const html = historyPage(slug);
        if (!html) { send(404, page('Not found', '<div class="back"><a href="/">&larr; All contacts</a></div><p>No history for this contact.</p>')); return; }
        send(200, html);
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
