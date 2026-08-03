'use strict';
// evals/label-ui.js — click-through labelling for the tasks gold set.
//
//   node evals/label-ui.js            # serve + open Edge
//   node evals/label-ui.js --no-open
//   node evals/label-ui.js --port 3114
//
// WHY A SERVER AND NOT A CLI: 157 judgements, each needing three messages of context on
// either side to be answerable at all. That is unreadable in a terminal and miserable
// to redo, and a half-finished labelling session that has to be restarted is how gold
// sets die.
//
// IT WRITES BACK TO THE SAME MARKDOWN the checklist generator produced, in place. No
// new format, no database, no export step: `evals/tasks-run.js` reads those files
// already and does not know this UI exists. Label in the browser or in an editor,
// interchangeably — whichever is in front of you.
//
// LOCALHOST ONLY AND NO AUTH, unlike scripts/crm-web.js. That app has a password
// because it is a durable service; this is a scratch tool for one sitting. It binds
// 127.0.0.1 so nothing off-machine can reach it, and it serves private message content,
// so do not change that bind address.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parseGold, GOLD_DIR, LEDGER_DIR, GOLD_CONTACTS } = require('./tasks-fixtures');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  if (a === '--no-open') continue;
  if (a === '--port') { i += 1; continue; }
  console.error(`unknown flag '${a}'\nknown: --port <n>, --no-open`);
  process.exit(2);
}
const PORT = Number(arg('--port', 3114));

// ---- checklist parsing ----------------------------------------------------------
// The file is the source of truth and is hand-editable, so it is re-read on every
// request rather than cached. Nathan may well have an editor open on the same file.

function readChecklist(slug) {
  const file = path.posix.join(GOLD_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const items = [];
  for (const line of lines) {
    const m = /^- \[([ xX])\]\s*m(\d+)\s*\((\S+)\)\s*(.*)$/.exec(line);
    if (!m) continue;
    const d = /\bdue=(\d{4}-\d{2}-\d{2})/.exec(line);
    items.push({
      id: Number(m[2]),
      checked: m[1].toLowerCase() === 'x',
      why: m[3],
      text: m[4].replace(/\s*due=\d{4}-\d{2}-\d{2}\s*/, '').trim(),
      due: d ? d[1] : '',
    });
  }
  return { file, items };
}

// CONTEXT COMES FROM THE FROZEN LEDGER, NOT THE CHECKLIST. The checklist embeds three
// messages either side, which is right for reading the file by hand but far too little
// to judge a bare "ok" whose antecedent is thirty messages back. Widening the embedded
// context instead would take runqi's checklist from 582 lines to ~4,500 and make the
// file useless for hand-editing — so the two are decoupled: the .md stays small and
// legible, and the UI slices any window it likes out of the ledger by message id.
const ledgerCache = new Map();

function readLedger(slug) {
  const file = path.posix.join(LEDGER_DIR, `${slug}.txt`);
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  const hit = ledgerCache.get(slug);
  if (hit && hit.mtime === st.mtimeMs) return hit.data;
  const msgs = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\[([^\]]+)\]\s*⟨m(\d+)⟩\s*([^:]+):\s?([\s\S]*)$/.exec(line);
    if (m) msgs.push({ when: m[1], id: Number(m[2]), who: m[3].trim(), body: m[4] });
  }
  const index = new Map(msgs.map((m, i) => [m.id, i]));
  const data = { msgs, index };
  // Frozen files, so this only ever reloads if someone --forces a rebuild mid-session.
  ledgerCache.set(slug, { mtime: st.mtimeMs, data });
  return data;
}

const CTX_BEFORE = 50;
const CTX_AFTER = 20;

function contextFor(slug, id, before = CTX_BEFORE, after = CTX_AFTER) {
  const led = readLedger(slug);
  if (!led) return [];
  const at = led.index.get(id);
  if (at === undefined) return [];
  const lo = Math.max(0, at - before);
  const hi = Math.min(led.msgs.length - 1, at + after);
  return led.msgs.slice(lo, hi + 1).map((m) => ({ ...m, here: m.id === id }));
}

// Rewrite ONE candidate line. Read-modify-write per click rather than holding state in
// memory: the file may also be edited by hand mid-session, and losing someone's manual
// labels to a stale in-memory copy would be unforgivable for a file that costs 20
// minutes to produce.
function writeLabel(slug, id, checked, due) {
  const file = path.posix.join(GOLD_DIR, `${slug}.md`);
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  let found = false;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^- \[([ xX])\]\s*m(\d+)\s*(.*)$/.exec(lines[i]);
    if (!m || Number(m[2]) !== id) continue;
    let rest = m[3].replace(/\s*due=\d{4}-\d{2}-\d{2}/g, '');
    if (checked && due) rest = `${rest.replace(/\s+$/, '')}  due=${due}`;
    lines[i] = `- [${checked ? 'x' : ' '}] m${id} ${rest}`;
    found = true;
    break;
  }
  if (!found) return false;
  // tmp + rename so an interrupted write cannot truncate the checklist.
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n'));
  fs.renameSync(tmp, file);
  return true;
}

// ---- html -----------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--bg:#0f1115;--fg:#e6e6e6;--dim:#8b93a1;--line:#242833;--yes:#2ea043;--no:#30363d;--acc:#4493f8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,Menlo,Consolas,monospace}
header{position:sticky;top:0;background:#12151c;border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;z-index:5}
a{color:var(--acc);text-decoration:none}
h1{font-size:15px;margin:0;font-weight:600}
.prog{color:var(--dim)}
.bar{height:4px;background:var(--line);border-radius:2px;overflow:hidden;width:180px}
.bar>i{display:block;height:100%;background:var(--yes)}
main{max-width:1000px;margin:0 auto;padding:16px}
.item{border:1px solid var(--line);border-radius:8px;margin:0 0 14px;padding:12px;background:#12151c;scroll-margin-top:70px}
.item.on{border-color:var(--yes);background:#121a14}
.item.cur{outline:2px solid var(--acc)}
.q{font-weight:600;margin-bottom:8px}
.why{color:var(--dim);font-weight:400;font-size:12px;border:1px solid var(--line);border-radius:10px;padding:1px 7px;margin-left:6px}
.ctx{margin:8px 0;border-left:2px solid var(--line);padding-left:10px;max-height:360px;overflow-y:auto;overscroll-behavior:contain}
.ctx div{color:var(--dim);white-space:pre-wrap;word-break:break-word}
.ctx div.here{color:var(--fg);background:#1b2030;border-radius:4px;padding:1px 4px;scroll-margin-top:140px}
.ctx div.me{color:#a9b4c4}
.who{color:#c9a227}
.ctxbar{display:flex;gap:8px;align-items:center;margin-top:6px}
.ctxbar button{padding:2px 10px;font-size:12px}
.row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
button{font:inherit;padding:5px 14px;border-radius:6px;border:1px solid var(--line);background:#1b1f27;color:var(--fg);cursor:pointer}
button.y.on{background:var(--yes);border-color:var(--yes);color:#fff}
button.n.on{background:#464d57;border-color:#464d57}
input[type=date]{font:inherit;background:#1b1f27;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
.hint{color:var(--dim);font-size:12px}
.done{color:var(--yes)}
table{border-collapse:collapse;width:100%}
td,th{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
`;

function indexPage() {
  const rows = GOLD_CONTACTS.map(({ slug, note }) => {
    const c = readChecklist(slug);
    if (!c) return '';
    const done = c.items.filter((i) => i.checked).length;
    return `<tr><td><a href="/c/${esc(slug)}">${esc(slug)}</a></td>
      <td>${c.items.length}</td><td class="${done ? 'done' : ''}">${done}</td>
      <td class="hint">${esc(note)}</td></tr>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><title>Gold labelling</title><style>${CSS}</style>
  <header><h1>Tasks gold set</h1><span class="hint">tick the lines that are real commitments of yours</span></header>
  <main><table><tr><th>contact</th><th>candidates</th><th>marked yes</th><th></th></tr>${rows}</table>
  <p class="hint">Writes straight to <code>data/_eval-tasks/gold/*.md</code>. Then run
  <code>node evals/tasks-run.js --variant v1,v2,v3</code>.</p></main>`;
}

function renderCtx(ctx) {
  return ctx.map((x) => `<div class="${x.here ? 'here' : (x.who === 'Nathan' ? 'me' : '')}">[${esc(x.when)}] <span class="who">${esc(x.who)}</span>: ${esc(x.body)}</div>`).join('');
}

function contactPage(slug) {
  const c = readChecklist(slug);
  if (!c) return null;
  const idx = GOLD_CONTACTS.findIndex((g) => g.slug === slug);
  const next = GOLD_CONTACTS[idx + 1];
  const done = c.items.filter((i) => i.checked).length;

  const items = c.items.map((it, n) => `
  <div class="item${it.checked ? ' on' : ''}" id="i${it.id}" data-id="${it.id}" data-n="${n}">
    <div class="q">${n + 1}. ${esc(it.text)}<span class="why">${esc(it.why)}</span></div>
    <div class="ctx" id="ctx${it.id}">${renderCtx(contextFor(slug, it.id))}</div>
    <div class="ctxbar">
      <button onclick="widen(${it.id})">load 200 more before / 100 after</button>
      <span class="hint" id="cn${it.id}"></span>
    </div>
    <div class="row">
      <button class="y${it.checked ? ' on' : ''}" onclick="mark(${it.id},1)">commitment</button>
      <button class="n${it.checked ? '' : ' on'}" onclick="mark(${it.id},0)">no</button>
      <span class="hint">deadline (optional)</span>
      <input type="date" value="${esc(it.due)}" onchange="mark(${it.id},1,this.value)">
    </div>
  </div>`).join('');

  return `<!doctype html><meta charset="utf-8"><title>${esc(slug)} — labelling</title><style>${CSS}</style>
  <header>
    <a href="/">&larr; all</a><h1>${esc(slug)}</h1>
    <div class="bar"><i id="bar" style="width:${c.items.length ? (done / c.items.length) * 100 : 0}%"></i></div>
    <span class="prog" id="prog">${done} / ${c.items.length} marked</span>
    <span class="hint">j/k move · y yes · n no · saves instantly</span>
    ${next ? `<a href="/c/${esc(next.slug)}">next: ${esc(next.slug)} &rarr;</a>` : '<span class="done">last contact</span>'}
  </header>
  <main>${items || '<p class="hint">no candidates</p>'}</main>
  <script>
  const N = ${c.items.length};
  const SLUG = ${JSON.stringify(slug)};
  let cur = 0;
  // Each context box is scrolled so the candidate sits in the middle of its own pane —
  // with 50 messages before it, the default scroll position would land you 50 messages
  // above the line you are being asked about.
  function centreAll(){
    document.querySelectorAll('.ctx').forEach(box=>{
      const h = box.querySelector('.here');
      if(h) box.scrollTop = h.offsetTop - box.clientHeight/2 + h.clientHeight/2;
    });
  }
  async function widen(id){
    const box = document.getElementById('ctx'+id);
    const note = document.getElementById('cn'+id);
    note.textContent = 'loading…';
    const r = await fetch('/api/ctx?slug='+encodeURIComponent(SLUG)+'&id='+id+'&before=250&after=120');
    if(!r.ok){ note.textContent = 'failed'; return; }
    const j = await r.json();
    box.innerHTML = j.html;
    note.textContent = j.count + ' messages shown' + (j.truncated ? ' (whole ledger)' : '');
    const h = box.querySelector('.here');
    if(h) box.scrollTop = h.offsetTop - box.clientHeight/2 + h.clientHeight/2;
  }
  function paint(){
    document.querySelectorAll('.item').forEach((e,i)=>e.classList.toggle('cur', i===cur));
    const on = document.querySelectorAll('.item.on').length;
    document.getElementById('prog').textContent = on + ' / ' + N + ' marked';
    document.getElementById('bar').style.width = (N? on/N*100:0) + '%';
  }
  function go(d){ cur = Math.max(0, Math.min(N-1, cur+d)); const e=document.querySelectorAll('.item')[cur];
    if(e) e.scrollIntoView({block:'center',behavior:'smooth'}); paint(); }
  async function mark(id, val, due){
    const box = document.getElementById('i'+id);
    // Optimistic paint, reverted if the write fails — a silently dropped label is the
    // one failure this tool must not have.
    box.classList.toggle('on', !!val);
    box.querySelector('.y').classList.toggle('on', !!val);
    box.querySelector('.n').classList.toggle('on', !val);
    paint();
    const r = await fetch('/api/label', {method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({slug:${JSON.stringify(slug)}, id, checked:!!val, due: due||box.querySelector('input').value||''})});
    if(!r.ok){ alert('save FAILED for m'+id+' — reload before continuing'); }
  }
  document.addEventListener('keydown', e=>{
    if(e.target.tagName==='INPUT') return;
    const items=document.querySelectorAll('.item'); const id=items[cur] && +items[cur].dataset.id;
    if(e.key==='j'){go(1);e.preventDefault()}
    else if(e.key==='k'){go(-1);e.preventDefault()}
    else if(e.key==='y'&&id){mark(id,1);go(1);e.preventDefault()}
    else if(e.key==='n'&&id){mark(id,0);go(1);e.preventDefault()}
    else if(e.key==='m'&&id){widen(id);e.preventDefault()}
  });
  centreAll();
  paint();
  </script>`;
}

// ---- server ---------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const send = (code, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type }); res.end(body);
  };
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/api/label') {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(raw);
        if (!GOLD_CONTACTS.some((g) => g.slug === b.slug)) return send(400, 'bad slug', 'text/plain');
        const ok = writeLabel(b.slug, Number(b.id), !!b.checked, /^\d{4}-\d{2}-\d{2}$/.test(b.due || '') ? b.due : '');
        return send(ok ? 200 : 404, ok ? 'ok' : 'no such candidate', 'text/plain');
      } catch (e) {
        return send(500, String(e.message), 'text/plain');
      }
    });
    return;
  }

  if (url.pathname === '/api/ctx') {
    const slug = url.searchParams.get('slug');
    if (!GOLD_CONTACTS.some((g) => g.slug === slug)) return send(400, 'bad slug', 'text/plain');
    const id = Number(url.searchParams.get('id'));
    const before = Math.min(2000, Number(url.searchParams.get('before')) || CTX_BEFORE);
    const after = Math.min(2000, Number(url.searchParams.get('after')) || CTX_AFTER);
    const ctx = contextFor(slug, id, before, after);
    const led = readLedger(slug);
    return send(200, JSON.stringify({
      html: renderCtx(ctx),
      count: ctx.length,
      truncated: !!led && ctx.length >= led.msgs.length,
    }), 'application/json');
  }

  if (url.pathname === '/') return send(200, indexPage());
  const m = /^\/c\/([a-z0-9-]+)$/.exec(url.pathname);
  if (m) {
    const page = contactPage(m[1]);
    return page ? send(200, page) : send(404, 'no checklist for that contact', 'text/plain');
  }
  return send(404, 'not found', 'text/plain');
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`labelling UI: ${url}`);
  console.log(`writing to:   ${GOLD_DIR}`);
  console.log(`ledgers:      ${LEDGER_DIR}`);
  console.log('\nkeys: j/k move · y commitment · n no · saves on every click');
  console.log('Ctrl-C when done, then: node evals/tasks-run.js --variant v1,v2,v3');
  if (!argv.includes('--no-open')) {
    // Edge by name; `start` falls back to the default browser if it is absent.
    execFile('cmd', ['/c', 'start', 'msedge', url], (e) => {
      if (e) execFile('cmd', ['/c', 'start', '', url], () => {});
    });
  }
});
