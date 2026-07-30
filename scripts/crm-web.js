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
  // Provenance citations: ⟨m89123, m89150⟩ → superscript links to /m/<id>
  out = out.replace(/⟨\s*(m\d+(?:\s*,\s*m\d+)*)\s*⟩/g, (_, grp) => {
    const links = grp.split(',').map((p, idx) => {
      const id = p.trim().slice(1);
      return `<a href="/m/${id}" title="source message m${id}">${idx + 1}</a>`;
    });
    return `<sup class="cites">${links.join('')}</sup>`;
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
function parseTalkingPoints(md) {
  const items = [];
  let inSection = false;
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (/^##\s+Talking points/i.test(t)) { inSection = true; continue; }
    if (inSection && /^##?\s/.test(t) && /^#/.test(t)) break; // next heading ends it
    if (!inSection) continue;
    const m = t.match(/^[-*]\s+(?:\*\*(\d{4}-\d{2}-\d{2})\*\*\s*)?(.+)$/);
    if (m && m[2]) items.push({ date: m[1] || null, text: m[2].trim() });
  }
  return items;
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
  const body = `<div class="back"><a href="/">&larr; All contacts</a></div><div class="profile">${renderMarkdown(md)}</div>`;
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

  const canDiff = run.preSha && run.postSha && run.preSha !== run.postSha;
  const contactsHtml = (run.contacts || []).length
    ? `<h2>Contacts</h2><table class="tbl"><tr><th>Contact</th><th>Msgs</th><th>Cursor</th><th>Merge</th><th>Citations</th><th>Changes</th></tr>` +
      run.contacts.map((c) => {
        const cite = c.citations
          ? (c.citations.missing.length ? `<span class="bad">${c.citations.missing.length}/${c.citations.cited} missing</span>` : `<span class="ok">${c.citations.cited} ok</span>`)
          : '<span class="skip">—</span>';
        return `<tr><td><a href="/c/${encodeURIComponent(c.slug)}">${esc(c.name || c.slug)}</a></td>` +
          `<td class="num">${c.count}</td>` +
          `<td class="num">${c.cursorBefore == null ? 'backfill' : c.cursorBefore} → ${c.cursorAfter == null ? '—' : c.cursorAfter}</td>` +
          `<td>${c.ok ? `<span class="ok">ok</span> <span class="sub">${fmtMs(c.ms)}</span>` : `<span class="bad">FAILED</span> <span class="sub">${esc(String(c.error || '').slice(0, 200))}</span>`}</td>` +
          `<td>${cite}</td>` +
          `<td>${c.ok && canDiff ? `<a href="/runs/${encodeURIComponent(run.id)}/diff/${encodeURIComponent(c.slug)}">diff</a>` : '<span class="skip">—</span>'}</td></tr>`;
      }).join('') + `</table>`
    : '<p class="sub">No contacts had new activity.</p>';

  const warnHtml = (run.warnings || []).length
    ? `<h2>Warnings</h2><ul>${run.warnings.map((w) => `<li class="bad">${esc(w)}</li>`).join('')}</ul>`
    : '';

  const body = `<div class="back"><a href="/runs">&larr; All runs</a></div>` +
    `<header class="top"><h1>Run ${esc(fmtWhen(run.startedAt))}</h1>` +
    `<span class="sub">${esc(runMode(run))} · ${fmtMs(run.durationMs)}</span></header>` +
    `<h2>Steps</h2>${stepsHtml}${contactsHtml}${warnHtml}`;
  return page(`Run ${run.id}`, body, '/runs');
}

function diffPage(id, slug) {
  let run;
  try { run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${id}.json`), 'utf8')); } catch { return null; }
  if (!run.preSha || !run.postSha) return null;
  let diff;
  try {
    diff = execFileSync('git', ['--git-dir', GITDIR, 'diff', `${run.preSha}..${run.postSha}`, '--', `data/contacts/${slug}.md`],
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

      if (url.pathname === '/status') { send(200, statusPage()); return; }
      if (url.pathname === '/runs') { send(200, runsPage()); return; }
      const rdiff = url.pathname.match(/^\/runs\/([^/]+)\/diff\/([^/]+)$/);
      if (rdiff) {
        const id = decodeURIComponent(rdiff[1]);
        const slug = decodeURIComponent(rdiff[2]);
        if (!isSafeRunId(id) || !isSafeSlug(slug)) { send(400, page('Bad request', '<p>Bad request.</p>')); return; }
        const html = diffPage(id, slug);
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
