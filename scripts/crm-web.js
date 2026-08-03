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
  TRACKED, REFRESH_STATE, LOGS_DIR, GITDIR,
} = require('../lib/config');
const { openCrmDb, openSignalDb } = require('../lib/signal-db');
const { resolveSources, buildMessageQuery } = require('../lib/sources');
const { validateCitations } = require('../lib/archive');
const TASKS = require('../lib/tasks');

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
  // Provenance citations → superscript links to /m/<id>.
  //
  // TWO SHAPES, and only one used to work. The merge prompt emits one bracket per
  // id — `⟨m28684⟩ ⟨m28709⟩ ⟨m28714⟩` — which is what citation_syntax enforces,
  // but this only understood the comma form `⟨m1, m2⟩`. Each bracket matched
  // separately, so each got its own <sup> with the index restarting, and three
  // sources rendered as "1 1 1" instead of "1 2 3".
  //
  // Adjacent brackets are now coalesced into ONE <sup>, and the counter runs
  // across the whole line so a bullet with citations in two places still numbers
  // 1,2,3,4 rather than 1,2 then 1,2. Trailing whitespace is deliberately not
  // consumed, so the space before following prose survives.
  const GROUP = String.raw`⟨\s*m\d+(?:\s*,\s*m\d+)*\s*⟩`;
  let n = 0;
  out = out.replace(new RegExp(`${GROUP}(?:\\s*${GROUP})*`, 'g'), (run) => {
    const seen = new Set();
    const links = [];
    for (const m of run.matchAll(/m(\d+)/g)) {
      // The same id cited twice in one run would otherwise render as two
      // differently-numbered links to the same message.
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      n += 1;
      links.push(`<a href="/m/${m[1]}" title="source message m${m[1]}">${n}</a>`);
    }
    return links.length ? `<sup class="cites">${links.join('')}</sup>` : run;
  });
  return out;
}

const CHAT_RE = /^\[([^\]]+)\]\s+(?:⟨m(\d+)⟩\s+)?(?:\(([^)]+)\)\s+)?([^:]+):\s?(.*)$/;

// Render a full profile Markdown document to HTML.
function renderMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const html = [];
  let i = 0;
  let listOpen = false;
  let chatOpen = false;
  const closeList = () => { if (listOpen) { html.push('</ul>'); listOpen = false; } };
  const closeChat = () => { if (chatOpen) { html.push('</div>'); chatOpen = false; } };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') { closeList(); closeChat(); i++; continue; }

    // Chat transcript line: [ts] (group) Speaker: text
    const chat = trimmed.match(CHAT_RE);
    if (chat) {
      closeList();
      const [, ts, mid, group, speakerRaw, text] = chat;
      const speaker = speakerRaw.trim();
      const mine = /^nathan$/i.test(speaker);
      if (!chatOpen) { html.push('<div class="chat">'); chatOpen = true; }
      // When the line carries a ⟨m…⟩ id, the timestamp links to the message's
      // provenance view (that message in its original conversation context).
      const tsHtml = mid ? `<a class="ts" href="/m/${mid}" title="view in context">${esc(ts)}</a>` : `<span class="ts">${esc(ts)}</span>`;
      html.push(
        `<div class="msg ${mine ? 'me' : 'them'}">` +
          `<div class="meta"><span class="who">${esc(speaker)}</span>` +
          (group ? `<span class="grp">${esc(group)}</span>` : '') +
          tsHtml + `</div>` +
          `<div class="body">${inline(text)}</div>` +
        `</div>`
      );
      i++;
      continue;
    }
    closeChat();

    // Headings
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeList(); html.push('<hr>'); i++; continue; }

    // List item
    const li = trimmed.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      html.push(`<li>${inline(li[1])}</li>`);
      i++;
      continue;
    }

    // Paragraph (gather consecutive non-structural lines)
    closeList();
    const para = [trimmed];
    i++;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t === '' || /^(#{1,6})\s/.test(t) || /^[-*]\s/.test(t) || CHAT_RE.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t)) break;
      para.push(t);
      i++;
    }
    html.push(`<p>${inline(para.join(' '))}</p>`);
  }
  closeList();
  closeChat();
  return html.join('\n');
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
const STYLE = `
:root{--bg:#f7f7f8;--card:#fff;--ink:#1c1c1e;--mut:#6b6b70;--line:#e5e5ea;--accent:#3b6ef5;--me:#e7f0ff;--them:#f0f0f2;}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--card:#1a1a1d;--ink:#ececf0;--mut:#9a9aa2;--line:#2a2a30;--accent:#6ea0ff;--me:#1e2f52;--them:#232327;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:820px;margin:0 auto;padding:28px 20px 80px}
header.top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:20px}
header.top h1{font-size:20px;margin:0}
.sub{color:var(--mut);font-size:13px}
.grid{display:grid;gap:12px}
.pcard{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;transition:border-color .15s}
.pcard:hover{border-color:var(--accent);text-decoration:none}
.pcard .nm{font-weight:600;font-size:17px}
.pcard .rl{color:var(--accent);font-size:13px;margin-left:8px}
.pcard .mt{color:var(--mut);font-size:13px;margin-top:4px;display:flex;gap:14px;flex-wrap:wrap}
.profile{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:8px 26px 26px}
.profile h1{font-size:26px;margin:18px 0 6px}
.profile h2{font-size:18px;margin:28px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.profile h3{font-size:15px;margin:20px 0 6px;color:var(--mut);text-transform:uppercase;letter-spacing:.03em}
.profile ul{padding-left:20px}.profile li{margin:5px 0}
.profile p{margin:10px 0}
.profile code{background:var(--them);padding:1px 5px;border-radius:5px;font-size:.9em}
.profile hr{border:0;border-top:1px solid var(--line);margin:18px 0}
.chat{display:flex;flex-direction:column;gap:6px;margin:12px 0}
.msg{max-width:80%;padding:7px 11px;border-radius:14px;font-size:14px}
.msg .meta{display:flex;gap:8px;align-items:baseline;font-size:11px;color:var(--mut);margin-bottom:2px}
.msg .who{font-weight:600;color:var(--ink)}
.msg .grp{background:var(--them);padding:0 6px;border-radius:6px}
.msg.me{align-self:flex-end;background:var(--me);border-bottom-right-radius:4px}
.msg.them{align-self:flex-start;background:var(--them);border-bottom-left-radius:4px}
.msg .body{white-space:pre-wrap;word-break:break-word}
.back{font-size:13px;color:var(--mut)}
sup.cites{font-size:10px;letter-spacing:1px;margin-left:2px}
sup.cites a{color:var(--mut);border:1px solid var(--line);border-radius:4px;padding:0 3px;margin-left:2px}
sup.cites a:hover{color:var(--accent);border-color:var(--accent);text-decoration:none}
.msg .meta a.ts{color:var(--mut)}
.msg .meta a.ts:hover{color:var(--accent)}
.msg.hit{outline:2px solid var(--accent);outline-offset:1px}
.sub{color:var(--mut);font-size:13px}
.radar{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin-bottom:18px}
.radar .rhead{font-weight:600;font-size:14px;margin-bottom:6px}
.radar ul{list-style:none;margin:0;padding:0}
.radar li{display:flex;gap:10px;align-items:baseline;padding:4px 0;font-size:14px;border-top:1px solid var(--line)}
.radar li:first-child{border-top:0}
.radar .rdate{flex:0 0 46px;font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
.radar .rdate.up{color:var(--accent);font-weight:600}
.radar a{font-weight:600;flex-shrink:0}
.radar .rtext{color:var(--ink)}
nav.main{display:flex;gap:16px;margin-bottom:18px;font-size:14px;border-bottom:1px solid var(--line);padding-bottom:10px}
nav.main a{color:var(--mut)}nav.main a.cur{color:var(--accent);font-weight:600}
table.tbl{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:14px}
table.tbl th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);text-align:left}
table.tbl th,table.tbl td{padding:8px 12px;border-bottom:1px solid var(--line)}
table.tbl tr:last-child td{border-bottom:0}
table.tbl td.num{font-variant-numeric:tabular-nums;text-align:right}
.ok{color:#2e9e5b}.bad{color:#d4453a}.skip{color:var(--mut)}
.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:8px;background:var(--them);color:var(--mut)}
.badge.hot{background:var(--me);color:var(--accent);font-weight:600}
pre.log{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
pre.diff{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:12px;overflow-x:auto}
pre.diff .add{color:#2e9e5b}pre.diff .del{color:#d4453a}pre.diff .hunk{color:var(--accent)}pre.diff .ctx{color:var(--mut)}
details.step{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:6px 0}
details.step summary{cursor:pointer;display:flex;gap:10px;align-items:baseline}
details.step summary .nm{font-weight:600}
details.step summary .ms{color:var(--mut);font-size:12px;margin-left:auto}
.actions form{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 10px 10px 0;vertical-align:top}
.actions button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:7px 14px;font-size:14px;cursor:pointer}
.actions button:disabled{opacity:.5;cursor:not-allowed}
.actions select{padding:6px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
.actions .cap{font-size:12px;color:var(--mut);margin-top:6px;max-width:220px}
`;

const NAV = [
  ['/', 'Contacts'],
  ['/tasks', 'Tasks'],
  ['/status', 'Status'],
  ['/runs', 'Runs'],
  ['/actions', 'Actions'],
];

function page(title, bodyHtml, current = '') {
  const nav = `<nav class="main">${NAV.map(([href, label]) =>
    `<a href="${href}" class="${href === current ? 'cur' : ''}">${label}</a>`).join('')}</nav>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="wrap">${nav}${bodyHtml}</div></body></html>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDateShort(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso;
}

// Flatten every contact's talking points into one radar list: upcoming events
// first (soonest first), then recent mentions (newest first), then undated.
function radarItems(contacts) {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = [];
  const recent = [];
  const undated = [];
  for (const c of contacts) {
    for (const tp of c.talkingPoints.slice(0, 4)) { // cap per contact so no one floods the radar
      const item = { ...tp, name: c.name, slug: c.slug };
      if (!tp.date) undated.push(item);
      else if (tp.date >= today) upcoming.push(item);
      else recent.push(item);
    }
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  recent.sort((a, b) => b.date.localeCompare(a.date));
  return [...upcoming, ...recent, ...undated].slice(0, 15);
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

// Build every draft an ingest run would have produced, minus the ones already
// accepted or dismissed. Drafts are not stored — they are recomputed each load, so
// a merge rewording a bullet re-drafts it rather than mutating an owned task.
function buildDrafts(db) {
  const known = TASKS.knownKeys(db);
  const out = [];
  for (const c of taskItems().all) {
    const d = TASKS.draftFrom(c.slug, c.name, c);
    if (known.has(d.key)) continue;
    out.push(d);
  }
  return out.sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
}

function tasksPage(editId = null) {
  let cdb;
  try { cdb = openCrmDb(); } catch { return page('To do', '<p class="bad">archive unavailable</p>', '/tasks'); }
  let drafts = [];
  let active = [];
  let done = [];
  let editing = null;
  try {
    drafts = buildDrafts(cdb);
    active = TASKS.listTasks(cdb, 'active');
    done = TASKS.listTasks(cdb, 'done');
    if (editId) editing = TASKS.getTask(cdb, editId);
  } finally {
    try { cdb.close(); } catch { /* closed */ }
  }

  const today = new Date().toISOString().slice(0, 10);
  const hidden = (o) => Object.entries(o)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v == null ? '' : String(v))}">`).join('');

  // "who it came from" and "which message triggered it" — the two provenance facts
  // that stay visible after acceptance, since they are the reason the task exists.
  const srcHtml = (t) => {
    const ids = String(t.source_msg_ids || '').split(',').filter(Boolean);
    const links = ids.slice(0, 4)
      .map((id) => `<a href="/m/${esc(id)}">m${esc(id)}</a>`).join(' ');
    return `<div class="tsrc">from <a href="/c/${encodeURIComponent(t.slug)}">${esc(t.contact_name || t.slug)}</a>`
      + (links ? ` · triggered by ${links}` : ' · no source message')
      + `</div>`;
  };

  const draftRow = (d) => `<li class="dr">`
    + `<div class="dtitle">${esc(d.title)}</div>`
    + `<div class="dmeta">${esc(d.contactName || d.slug)}${d.deadline ? ` · ${esc(d.deadline)}` : ''}`
    + (d.sourceMsgId ? ` · <a href="/m/${d.sourceMsgId}">m${d.sourceMsgId}</a>` : '')
    + `</div>`
    + (d.description ? `<details class="dwhy"><summary>context</summary><div>${inline(d.description)}</div></details>` : '')
    + `<div class="dacts">`
    + `<form method="post" action="/tasks/accept">${hidden({
      key: d.key, slug: d.slug, contactName: d.contactName, title: d.title,
      description: d.description, deadline: d.deadline, sourceMsgId: d.sourceMsgId,
      sourceMsgIds: (d.sourceMsgIds || []).join(','), originText: d.originText,
    })}<button class="btn ok" type="submit">+ add</button></form>`
    + `<form method="post" action="/tasks/dismiss">${hidden({
      key: d.key, slug: d.slug, contactName: d.contactName, title: d.title,
      description: d.description, deadline: d.deadline, sourceMsgId: d.sourceMsgId,
      sourceMsgIds: (d.sourceMsgIds || []).join(','), originText: d.originText,
    })}<button class="btn" type="submit">dismiss</button></form>`
    + `</div></li>`;

  const editForm = (t) => `<form method="post" action="/tasks/edit" class="ed">`
    + hidden({ id: t.id })
    + `<label>Title<input name="title" value="${esc(t.title)}" maxlength="300"></label>`
    + `<label>Description<textarea name="description" rows="3">${esc(t.description || '')}</textarea></label>`
    + `<label>Deadline <span class="hint">YYYY-MM-DD, or blank</span>`
    + `<input name="deadline" value="${esc(t.deadline || '')}" placeholder="2026-09-01" maxlength="20"></label>`
    + `<div class="dacts"><button class="btn ok" type="submit">save</button>`
    + `<a class="btn" href="/tasks">cancel</a></div></form>`;

  const taskRow = (t) => {
    const isEditing = editing && editing.id === t.id;
    const overdue = t.deadline && t.deadline < today && t.status === 'active';
    return `<li class="tr${t.status === 'done' ? ' isdone' : ''}">`
      + `<form method="post" action="/tasks/done" class="tform">`
      + hidden({ id: t.id, done: t.status === 'done' ? '0' : '1' })
      + `<button type="submit" class="tbox">${t.status === 'done' ? '☑' : '☐'}</button></form>`
      + `<div class="tbody">`
      + `<div class="tline"><span class="ttitle">${esc(t.title)}</span>`
      + (t.deadline ? `<span class="tdate${overdue ? ' od' : ''}">${esc(t.deadline)}</span>` : '')
      + (isEditing ? '' : `<a class="btn sm" href="/tasks?edit=${t.id}">edit</a>`)
      + `</div>`
      + (t.description ? `<div class="tdesc">${inline(t.description)}</div>` : '')
      + srcHtml(t)
      + (isEditing ? editForm(t) : '')
      + `</div></li>`;
  };

  const st = `<style>
    .cols{display:grid;grid-template-columns:1fr;gap:22px}
    @media(min-width:900px){.cols{grid-template-columns:1fr 320px}}
    ul.tl,ul.dl{list-style:none;padding:0;margin:6px 0}
    li.tr{display:flex;gap:8px;align-items:flex-start;padding:8px 4px;border-bottom:1px solid var(--line)}
    li.isdone .ttitle{text-decoration:line-through;color:var(--mut)}
    .tform{margin:0}
    .tbox{background:none;border:none;font-size:17px;cursor:pointer;padding:0 2px;color:var(--mut)}
    .tbox:hover{color:var(--accent)}
    .tbody{flex:1;min-width:0}
    .tline{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
    .ttitle{flex:1 1 auto;min-width:0;font-weight:500}
    .tdesc{font-size:13px;color:var(--mut);margin:2px 0}
    .tsrc{font-size:11px;color:var(--mut);margin-top:2px}
    .tdate{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
    .tdate.od{color:#c2410c;font-weight:600}
    .side{border-left:1px solid var(--line);padding-left:16px}
    @media(max-width:899px){.side{border-left:none;padding-left:0;border-top:1px solid var(--line);padding-top:12px}}
    li.dr{border:1px solid var(--line);border-radius:6px;padding:7px 8px;margin-bottom:8px;background:var(--card)}
    .dtitle{font-size:13px;font-weight:500}
    .dmeta{font-size:11px;color:var(--mut);margin-top:2px}
    .dwhy{font-size:12px;color:var(--mut);margin-top:4px}
    .dwhy summary{cursor:pointer;font-size:11px}
    .dacts{display:flex;gap:6px;margin-top:6px;align-items:center}
    .dacts form{margin:0}
    .btn{font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:5px;background:var(--card);
         color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
    .btn.ok{border-color:var(--accent);color:var(--accent)}
    .btn.sm{font-size:10px;padding:1px 6px}
    .ed{margin:8px 0;padding:8px;border:1px solid var(--accent);border-radius:6px;display:grid;gap:6px}
    .ed label{display:grid;gap:3px;font-size:11px;color:var(--mut)}
    .ed input,.ed textarea{font:inherit;font-size:13px;padding:4px 6px;border:1px solid var(--line);
         border-radius:4px;background:var(--bg);color:var(--ink);width:100%}
    .hint{color:var(--mut);font-weight:400}
    h2{font-size:15px;margin:18px 0 4px}
  </style>`;

  const body = st
    + `<header class="top"><h1>To do</h1>`
    + `<span class="sub">${active.length} active · ${done.length} done · ${drafts.length} draft${drafts.length === 1 ? '' : 's'}</span></header>`
    + `<div class="cols"><div>`
    + (active.length ? `<ul class="tl">${active.map(taskRow).join('')}</ul>`
      : '<p>No active tasks. Add one from the drafts panel.</p>')
    + (done.length ? `<h2>Done</h2><ul class="tl">${done.map(taskRow).join('')}</ul>` : '')
    + `</div><div class="side">`
    + `<h2>Drafts <span class="hint">${drafts.length}</span></h2>`
    + `<p style="font-size:11px;color:var(--mut);margin:0 0 8px">Suggested by ingest runs. Add one to make it yours &mdash; then you can edit it.</p>`
    + (drafts.length ? `<ul class="dl">${drafts.map(draftRow).join('')}</ul>` : '<p style="font-size:12px;color:var(--mut)">No new suggestions.</p>')
    + `</div></div>`;
  return page('To do', body, '/tasks');
}

function indexPage() {
  const contacts = listContacts();
  const short = (s) => (s.length > 48 ? `${s.slice(0, 47).trimEnd()}…` : s);

  const radar = radarItems(contacts);
  const today = new Date().toISOString().slice(0, 10);
  const radarHtml = radar.length
    ? `<div class="radar"><div class="rhead">📌 Radar — things to bring up</div><ul>` +
      radar.map((r) =>
        `<li><span class="rdate ${r.date && r.date >= today ? 'up' : ''}">${r.date ? esc(fmtDateShort(r.date)) : '·'}</span>` +
        `<a href="/c/${encodeURIComponent(r.slug)}">${esc(r.name.split(' ')[0])}</a><span class="rtext">${inline(r.text)}</span></li>`
      ).join('') +
      `</ul></div>`
    : '';

  const cards = contacts.map((c) =>
    `<a class="pcard" href="/c/${encodeURIComponent(c.slug)}">` +
      `<div><span class="nm">${esc(c.name)}</span>${c.relationship ? `<span class="rl">${esc(short(c.relationship))}</span>` : ''}</div>` +
      `<div class="mt">${c.last ? `<span>Last contact ${esc(c.last)}</span>` : ''}${c.messages ? `<span>${esc(c.messages)}</span>` : ''}` +
      `${c.talkingPoints.length ? `<span>📌 ${c.talkingPoints.length} talking point${c.talkingPoints.length === 1 ? '' : 's'}</span>` : ''}</div>` +
    `</a>`
  ).join('');
  const body = `<header class="top"><h1>Personal CRM</h1><span class="sub">${contacts.length} contacts</span></header>${radarHtml}<div class="grid">${cards}</div>`;
  return page('Personal CRM', body, '/');
}

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
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    const bubbles = [...before, msg, ...after].map((m) => {
      const mine = /^nathan$/i.test(m.sender);
      const hit = m.id === msg.id;
      return `<div class="msg ${mine ? 'me' : 'them'}${hit ? ' hit' : ''}"${hit ? ' id="target"' : ''}>` +
        `<div class="meta"><span class="who">${esc(m.sender)}</span><span class="ts">${esc(fmt(m.sent_at))}</span></div>` +
        `<div class="body">${inline(m.body)}</div></div>`;
    }).join('');
    const backHref = msg.contact_slug ? `/c/${encodeURIComponent(msg.contact_slug)}` : '/';
    const body = `<div class="back"><a href="${backHref}">&larr; back</a></div>` +
      `<div class="profile"><h1>${esc(msg.conversation || 'Conversation')}</h1>` +
      `<p class="sub">source message <code>m${msg.id}</code>, shown in context</p>` +
      `<div class="chat">${bubbles}</div></div>` +
      `<script>var t=document.getElementById('target');if(t)t.scrollIntoView({block:'center'});</script>`;
    return page(`m${msg.id} — ${msg.conversation || 'message'}`, body);
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
  const body = `<div class="back"><a href="/">&larr; All contacts</a>`
    + ` &middot; <a href="/c/${encodeURIComponent(slug)}/history">History &rarr;</a></div>`
    + `<div class="profile">${renderMarkdown(md)}</div>`;
  return page(name, body);
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

function statusPage() {
  const slugs = loadTrackedSlugs();
  const cursors = loadCursors();
  const runs = loadRuns();
  // Latest successful merge per contact, from the run records.
  const lastMerged = {};
  for (const run of runs) {
    for (const c of run.contacts || []) {
      if (c.ok && !lastMerged[c.slug]) lastMerged[c.slug] = { when: run.startedAt, count: c.count };
    }
  }

  let cdb = null;
  let sdb = null;
  const rows = [];
  try {
    cdb = openCrmDb();
    sdb = openSignalDb();
    const now = Date.now();
    for (const slug of slugs) {
      const rel = `data/contacts/${slug}.md`;
      const row = { slug, name: slug, mode: '—', cursor: null, pending: null, lastMerged: lastMerged[slug] || null, citations: null, note: '' };
      const contact = cdb.prepare('SELECT signal_id, name FROM contacts WHERE file_path = ?').get(rel);
      if (!contact || !contact.signal_id) { row.note = 'no Signal id linked'; rows.push(row); continue; }
      row.name = contact.name || slug;
      const hasCursor = Object.prototype.hasOwnProperty.call(cursors, slug);
      row.mode = hasCursor ? 'incremental' : 'backfill (30d)';
      row.cursor = hasCursor ? cursors[slug] : null;
      const bound = hasCursor
        ? { clause: 'rowid > ?', param: cursors[slug] || 0 }
        : { clause: 'sent_at >= ?', param: now - BACKFILL_DAYS * DAY };
      const sources = resolveSources(sdb, contact.signal_id);
      const q = buildMessageQuery(sources, contact.signal_id, bound);
      row.pending = q ? sdb.prepare(`SELECT COUNT(*) AS n FROM (${q.sql})`).get(q.params).n : 0;
      try {
        const md = fs.readFileSync(path.posix.join(CONTACTS_DIR, `${slug}.md`), 'utf8');
        row.citations = validateCitations(cdb, md);
      } catch { /* profile missing or archive not created */ }
      rows.push(row);
    }
  } catch (e) {
    return page('Status', `<h1>Status</h1><p class="bad">Failed to read databases: ${esc(String(e).slice(0, 300))}</p>`, '/status');
  } finally {
    try { if (sdb) sdb.close(); } catch { /* ignore */ }
    try { if (cdb) cdb.close(); } catch { /* ignore */ }
  }
  rows.sort((a, b) => (b.pending || 0) - (a.pending || 0));

  const totalPending = rows.reduce((s, r) => s + (r.pending || 0), 0);
  const tr = rows.map((r) => {
    const cite = r.citations
      ? (r.citations.missing.length
        ? `<span class="bad">${r.citations.missing.length}/${r.citations.cited} missing</span>`
        : (r.citations.cited ? `<span class="ok">${r.citations.cited} ok</span>` : '<span class="skip">none</span>'))
      : '<span class="skip">—</span>';
    return `<tr><td><a href="/c/${encodeURIComponent(r.slug)}">${esc(r.name)}</a>${r.note ? ` <span class="bad">(${esc(r.note)})</span>` : ''}</td>` +
      `<td><span class="badge${r.mode.startsWith('backfill') ? ' hot' : ''}">${esc(r.mode)}</span></td>` +
      `<td class="num">${r.pending == null ? '—' : `<strong>${r.pending}</strong>`}</td>` +
      `<td class="num">${r.cursor == null ? '—' : r.cursor}</td>` +
      `<td>${r.lastMerged ? `${esc(fmtWhen(r.lastMerged.when))} (${r.lastMerged.count} msgs)` : '<span class="skip">never</span>'}</td>` +
      `<td>${cite}</td></tr>`;
  }).join('');

  const body = `<header class="top"><h1>Pipeline status</h1>` +
    `<span class="sub">${rows.length} tracked · ${totalPending} unmerged message${totalPending === 1 ? '' : 's'} waiting</span></header>` +
    `<p class="sub">“Unmerged” is computed live against Signal's database using the same source rules the pipeline uses — this is exactly what the next run would process. Backfill = first-ever run for that contact (last ${BACKFILL_DAYS} days); incremental = everything since their cursor.</p>` +
    `<table class="tbl"><tr><th>Contact</th><th>Next run mode</th><th>Unmerged</th><th>Cursor</th><th>Last merged</th><th>Citations</th></tr>${tr}</table>`;
  return page('Status — Personal CRM', body, '/status');
}

// ---------------------------------------------------------------------------
// Screen A — /runs, /runs/<id>, /runs/<id>/diff/<slug>
// ---------------------------------------------------------------------------
function runsPage() {
  const runs = loadRuns();
  const tr = runs.map((r) => {
    const failures = (r.mergeFailures || []).length;
    const warn = (r.warnings || []).length;
    return `<tr><td><a href="/runs/${encodeURIComponent(r.id)}">${esc(fmtWhen(r.startedAt))}</a></td>` +
      `<td><span class="badge">${esc(runMode(r))}</span></td>` +
      `<td class="num">${fmtMs(r.durationMs)}</td>` +
      `<td class="num">${r.contactsWithActivity ?? ''}</td>` +
      `<td class="num">${(r.merged || []).length}</td>` +
      `<td class="num">${failures ? `<span class="bad">${failures}</span>` : '0'}</td>` +
      `<td class="num">${warn ? `<span class="bad">${warn}</span>` : '0'}</td></tr>`;
  }).join('');
  const body = `<header class="top"><h1>Runs</h1><span class="sub">${runs.length} recorded</span></header>` +
    (runs.length
      ? `<table class="tbl"><tr><th>Started</th><th>Mode</th><th>Duration</th><th>Activity</th><th>Merged</th><th>Failures</th><th>Warnings</th></tr>${tr}</table>`
      : '<p class="sub">No recorded runs yet — records are written by every non-dry run from now on.</p>');
  return page('Runs — Personal CRM', body, '/runs');
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
        ? ` · compact <code>${esc(run.models.compact)}</code>` : '') + `</span>`
    : '';
  const cc = run.compactCitations;
  const compactCiteHtml = cc
    ? `<h2>Timeline citations (post-compact)</h2><p class="${cc.bad && cc.bad.length ? 'bad' : 'ok'}">` +
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
// Screen C — /actions: launch runs from the browser, one at a time
// ---------------------------------------------------------------------------
// In-memory single-job lock. This is also the only sanctioned way to launch
// overlapping-able work from the UI — a second launch while one is running is
// rejected with 409 rather than interleaving cursor state.
let job = null; // { mode, slug, argv, startedAt, endedAt, running, exit, buf }

function startJob(mode, slug) {
  if (job && job.running) return { ok: false, error: 'a run is already in progress' };
  const daily = path.join(ROOT, 'scripts', 'crm-daily.js');
  const compact = path.join(ROOT, 'scripts', 'crm-compact.js');
  let argv;
  if (mode === 'full') argv = [daily];
  else if (mode === 'dry') argv = [daily, '--dry-run'];
  else if (mode === 'only' && slug && /^[a-z0-9._-]+$/i.test(slug)) argv = [daily, '--only', slug];
  else if (mode === 'compact') argv = [compact, '--write'];
  else return { ok: false, error: 'bad mode' };

  job = { mode, slug: slug || null, argv, startedAt: Date.now(), endedAt: null, running: true, exit: null, buf: '' };
  const child = spawn(process.execPath, argv, { cwd: ROOT });
  const append = (d) => {
    job.buf += d.toString();
    if (job.buf.length > 200_000) job.buf = job.buf.slice(-200_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', (code) => {
    job.running = false;
    job.exit = code;
    job.endedAt = Date.now();
    job.buf += `\n[exit ${code}]`;
  });
  child.on('error', (e) => {
    job.running = false;
    job.exit = -1;
    job.endedAt = Date.now();
    job.buf += `\n[spawn error: ${e.message}]`;
  });
  return { ok: true };
}

function actionsPage() {
  const slugs = loadTrackedSlugs();
  const opts = slugs.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  const body = `<header class="top"><h1>Actions</h1><span class="sub">runs launch the real pipeline scripts; one at a time</span></header>` +
    `<div class="actions">` +
    `<form method="post" action="/actions/run"><input type="hidden" name="mode" value="full">` +
    `<button>Full run</button><div class="cap">Autopromote, refresh everyone, merge each contact, compact all timelines.</div></form>` +
    `<form method="post" action="/actions/run"><input type="hidden" name="mode" value="only">` +
    `<select name="slug">${opts}</select> <button>Run one contact</button><div class="cap">Refresh + merge + cursor commit for one person. No compaction.</div></form>` +
    `<form method="post" action="/actions/run"><input type="hidden" name="mode" value="dry">` +
    `<button>Dry run</button><div class="cap">Plan only: shows what would merge. Touches nothing, no AI calls.</div></form>` +
    `<form method="post" action="/actions/run"><input type="hidden" name="mode" value="compact">` +
    `<button>Compact only</button><div class="cap">Rebuild every Timeline (raw week + aged summaries). AI summary calls, no merges.</div></form>` +
    `</div>` +
    `<h2>Current / last job</h2><div id="jobmeta" class="sub">loading…</div><pre class="log" id="out"></pre>` +
    `<script>
      async function poll() {
        try {
          const r = await fetch('/actions/status.json');
          const j = await r.json();
          const meta = document.getElementById('jobmeta');
          const out = document.getElementById('out');
          if (!j.job) { meta.textContent = 'No job has been launched from the UI yet.'; out.textContent = ''; }
          else {
            meta.textContent = '[' + j.job.mode + (j.job.slug ? ' ' + j.job.slug : '') + '] ' +
              (j.job.running ? 'RUNNING since ' + new Date(j.job.startedAt).toLocaleTimeString()
                             : 'finished, exit ' + j.job.exit);
            out.textContent = j.job.buf || '(no output yet)';
          }
          document.querySelectorAll('.actions button').forEach(b => b.disabled = !!(j.job && j.job.running));
        } catch (e) { /* server briefly busy */ }
        setTimeout(poll, 2000);
      }
      poll();
    </script>`;
  return page('Actions — Personal CRM', body, '/actions');
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
            if (action === 'accept' || action === 'dismiss') {
              const slug = p.get('slug') || '';
              if (!p.get('key') || !isSafeSlug(slug)) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
              const d = {
                key: p.get('key'),
                slug,
                contactName: p.get('contactName') || null,
                title: p.get('title') || '(untitled)',
                description: p.get('description') || null,
                deadline: p.get('deadline') || null,
                sourceMsgId: p.get('sourceMsgId') ? Number(p.get('sourceMsgId')) : null,
                sourceMsgIds: (p.get('sourceMsgIds') || '').split(',').filter(Boolean),
                originText: p.get('originText') || null,
              };
              if (action === 'accept') TASKS.acceptDraft(cdb, d); else TASKS.dismissDraft(cdb, d);
            } else if (action === 'done') {
              const id = p.get('id');
              if (!/^\d+$/.test(String(id))) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
              TASKS.setDone(cdb, id, p.get('done') === '1');
            } else if (action === 'edit') {
              const id = p.get('id');
              if (!/^\d+$/.test(String(id))) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
              TASKS.updateTask(cdb, id, {
                title: p.get('title'), description: p.get('description'), deadline: p.get('deadline'),
              });
            } else {
              send(404, page('Not found', '<p>Not found.</p>')); return;
            }
            res.writeHead(303, { Location: '/tasks' });
            res.end();
          } catch (e) {
            try { send(500, page('Error', `<p class="bad">${esc(String(e.message).slice(0, 200))}</p>`)); } catch { /* sent */ }
          } finally {
            if (cdb) try { cdb.close(); } catch { /* closed */ }
          }
        });
        return;
      }
      if (url.pathname === '/status') { send(200, statusPage()); return; }
      if (url.pathname === '/runs') { send(200, runsPage()); return; }
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

      if (url.pathname === '/actions' && req.method === 'GET') { send(200, actionsPage()); return; }
      if (url.pathname === '/actions/status.json') { sendJson(200, { job }); return; }
      if (url.pathname === '/actions/run' && req.method === 'POST') {
        // CSRF guard: modern browsers stamp cross-site requests; only allow
        // same-origin (or direct curl, which sends no Sec-Fetch-Site at all).
        const sfs = req.headers['sec-fetch-site'];
        if (sfs && sfs !== 'same-origin' && sfs !== 'none') { send(403, page('Forbidden', '<p>Cross-site request refused.</p>')); return; }
        readBody(req, (body) => {
          try {
            const params = new URLSearchParams(body);
            const r = startJob(params.get('mode'), params.get('slug'));
            if (!r.ok) { send(409, page('Busy', `<div class="back"><a href="/actions">&larr; Actions</a></div><p class="bad">${esc(r.error)}</p>`)); return; }
            res.writeHead(303, { Location: '/actions' });
            res.end();
          } catch {
            try { send(400, page('Bad request', '<p>Bad request.</p>')); } catch { /* sent */ }
          }
        });
        return;
      }

      const mm = url.pathname.match(/^\/m\/(\d+)$/);
      if (mm) {
        const html = messagePage(Number(mm[1]));
        if (!html) { send(404, page('Not found', '<div class="back"><a href="/">&larr; All contacts</a></div><p>Message not in the archive (it may predate provenance tracking).</p>')); return; }
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
