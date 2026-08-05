'use strict';
// evals/arena.js — human-preference arena for ranking merge prompts.
//
//   node evals/arena.js <runDir>                 # serve the voting UI (127.0.0.1)
//   node evals/arena.js <runDir> --pair e,f      # only this variant pair
//   node evals/arena.js <runDir> --tally         # print results, serve nothing
//   node evals/arena.js <runDir> --port 8788
//
// WHY THIS EXISTS. The deterministic checks are saturated: C and E (and now F)
// score 312/312 on every case including all held-out ones. They can prove a
// prompt keeps the contract; they cannot rank prompts — and the recorded lesson
// is that a check written to enforce a new rule is won by the next prompt that
// adds that rule, one generation of headroom per check. The judge ranks, but it
// is a model judging a model, with a self-preference bias that is itself on the
// roadmap to be measured. The one metric that cannot saturate is the end user's
// blind preference on real outputs: the profile exists for Nathan, so Nathan's
// vote IS the objective. When the arena goes all-ties, that is an honest "no
// material difference" — information, not a ceiling artifact.
//
// Fairness, same spirit as the judges:
//   BLIND      — sides are "A"/"B"; the variant behind each side is randomized
//                per comparison and never shown before (or after) the vote.
//   RESUMABLE  — votes append to <runDir>/arena-labels.jsonl; a voted
//                comparison is never served again. Kill and restart freely.
//   ISOLATED   — position bias is handled by randomizing sides rather than by
//                double-judging; the human is the scarce resource here.
//
// Compares variants WITHIN one run dir only, so both sides saw byte-identical
// fixtures. To compare across models, produce one run dir with both variants
// (or --fixtures-from) first — never point the arena at two different runs.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

function main() {
  const argv = process.argv.slice(2);
  const runDir = argv.find((a) => !a.startsWith('--'));
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  if (!runDir || !fs.existsSync(path.join(runDir, 'fixtures', 'cases.json'))) {
    console.error('usage: node evals/arena.js <runDir> [--pair e,f] [--port 8788] [--tally]');
    console.error('runDir must contain fixtures/cases.json (an evals/run.js artifact dir).');
    process.exit(2);
  }
  const cases = JSON.parse(fs.readFileSync(path.join(runDir, 'fixtures', 'cases.json'), 'utf8'));
  const labelsFile = path.join(runDir, 'arena-labels.jsonl');

  // Variants = subdirs of the run dir that actually hold case sandboxes.
  const all = fs.readdirSync(runDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'fixtures')
    .map((e) => e.name)
    .filter((v) => cases.some((c) => fs.existsSync(afterPath(runDir, v, c))));
  const pairArg = arg('--pair', null);
  const picked = pairArg ? pairArg.split(',').map((s) => s.trim()) : all;
  for (const v of picked) if (!all.includes(v)) { console.error(`variant '${v}' has no outputs in ${runDir} (have: ${all.join(', ') || 'none'})`); process.exit(2); }
  if (picked.length < 2) { console.error(`need at least 2 variants to compare (have: ${picked.join(', ') || 'none'})`); process.exit(2); }

  // One comparison per (case, unordered variant pair). Stable ids so labels
  // survive restarts; skip pairs where either side's output file is missing.
  const comparisons = [];
  for (const c of cases) {
    for (let i = 0; i < picked.length; i += 1) {
      for (let j = i + 1; j < picked.length; j += 1) {
        const [v1, v2] = [picked[i], picked[j]].sort();
        if (!fs.existsSync(afterPath(runDir, v1, c)) || !fs.existsSync(afterPath(runDir, v2, c))) {
          console.log(`skip ${c.name} ${v1}/${v2}: missing output`);
          continue;
        }
        comparisons.push({ id: `${c.name}::${v1}::${v2}`, case: c, v1, v2 });
      }
    }
  }

  const labels = readLabels(labelsFile);

  if (argv.includes('--tally')) { tally(comparisons, labels); return; }

  const port = Number(arg('--port', 8788));
  const pending = new Map(); // id -> { left, right } for votes in flight
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': `${type}; charset=utf-8` });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (req.method === 'GET' && req.url === '/') return send(200, PAGE, 'text/html');
    if (req.method === 'GET' && req.url === '/api/next') {
      const next = comparisons.find((x) => !labels.has(x.id));
      const done = comparisons.length - comparisons.filter((x) => !labels.has(x.id)).length;
      if (!next) return send(200, { done: true, voted: done, total: comparisons.length });
      // Random side assignment, held server-side so the client never sees a
      // variant name. crypto, not Math.random, only because it needs no seed.
      const flip = crypto.randomBytes(1)[0] < 128;
      const [left, right] = flip ? [next.v1, next.v2] : [next.v2, next.v1];
      pending.set(next.id, { left, right });
      const before = next.case.profile;
      return send(200, {
        id: next.id, name: next.case.name, why: next.case.why || '',
        messages: next.case.messages, voted: done, total: comparisons.length,
        ledger: next.case.ledger,
        left: diffLines(before, readAfter(runDir, left, next.case)),
        right: diffLines(before, readAfter(runDir, right, next.case)),
      });
    }
    if (req.method === 'POST' && req.url === '/api/vote') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        let b;
        try { b = JSON.parse(raw); } catch { return send(400, { error: 'bad json' }); }
        const cmp = comparisons.find((x) => x.id === b.id);
        const sides = pending.get(b.id);
        if (!cmp || !sides) return send(409, { error: 'stale comparison — reload' });
        if (!['left', 'right', 'tie'].includes(b.choice)) return send(400, { error: 'bad choice' });
        const rec = {
          id: cmp.id, case: cmp.case.name, pair: [cmp.v1, cmp.v2],
          winner: b.choice === 'tie' ? 'tie' : sides[b.choice],
          left: sides.left, right: sides.right,
          note: String(b.note || '').slice(0, 500), at: new Date().toISOString(),
        };
        fs.appendFileSync(labelsFile, JSON.stringify(rec) + '\n');
        labels.set(rec.id, rec);
        pending.delete(b.id);
        return send(200, { ok: true });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/tally') return send(200, tallyData(comparisons, labels));
    send(404, { error: 'not found' });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`arena: ${comparisons.length} comparison(s), ${labels.size} already voted`);
    console.log(`variants: ${picked.join(', ')}   labels: ${labelsFile}`);
    console.log(`\n  open http://127.0.0.1:${port}\n`);
    console.log('keys: a = left better, b = right better, t = tie. Ctrl+C when done, then --tally.');
  });
}

function afterPath(runDir, v, c) {
  return path.join(runDir, v, c.name, 'sandbox', 'data', 'contacts', `${c.slug}.md`);
}
function readAfter(runDir, v, c) {
  return fs.readFileSync(afterPath(runDir, v, c), 'utf8');
}
function readLabels(file) {
  const m = new Map();
  if (!fs.existsSync(file)) return m;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); m.set(r.id, r); } catch { /* torn write; ignore */ }
  }
  return m;
}

// Plain LCS line diff. Profiles are a few hundred lines; O(n·m) is nothing.
function diffLines(a, b) {
  const A = String(a).split('\n');
  const B = String(b).split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: A[i] }); i += 1; }
    else { out.push({ t: '+', s: B[j] }); j += 1; }
  }
  while (i < n) { out.push({ t: '-', s: A[i] }); i += 1; }
  while (j < m) { out.push({ t: '+', s: B[j] }); j += 1; }
  return out;
}

function tallyData(comparisons, labels) {
  const pairs = new Map(); // "v1|v2" -> { v1, v2, a: wins-for-v1, b: wins-for-v2, tie }
  for (const r of labels.values()) {
    const key = r.pair.join('|');
    if (!pairs.has(key)) pairs.set(key, { v1: r.pair[0], v2: r.pair[1], w1: 0, w2: 0, tie: 0, notes: [] });
    const p = pairs.get(key);
    if (r.winner === 'tie') p.tie += 1;
    else if (r.winner === r.pair[0]) p.w1 += 1;
    else p.w2 += 1;
    if (r.note) p.notes.push(`${r.case}: ${r.note}`);
  }
  return { voted: labels.size, total: comparisons.length, pairs: [...pairs.values()] };
}

function tally(comparisons, labels) {
  const t = tallyData(comparisons, labels);
  console.log(`\n${t.voted}/${t.total} comparisons voted\n`);
  if (!t.pairs.length) { console.log('(no votes yet)'); return; }
  for (const p of t.pairs) {
    const n = p.w1 + p.w2 + p.tie;
    console.log(`${p.v1} vs ${p.v2}:  ${p.v1} ${p.w1}, ${p.v2} ${p.w2}, tie ${p.tie}   (${n} vote(s))`);
    for (const note of p.notes) console.log(`    note ${note}`);
  }
  console.log('\nAll ties is a real verdict: no material difference at this fixture set.');
}

// One page, zero dependencies. Sides are only ever "A" and "B".
const PAGE = `<!doctype html><meta charset="utf-8"><title>merge arena</title>
<style>
  body { font: 14px/1.45 system-ui, sans-serif; margin: 0; background: #111; color: #ddd; }
  header { padding: 10px 16px; background: #1a1a1a; position: sticky; top: 0; display: flex; gap: 16px; align-items: baseline; }
  header b { color: #fff; } header .prog { color: #888; }
  main { padding: 12px 16px 90px; }
  details { margin: 8px 0; } summary { cursor: pointer; color: #9ad; }
  pre { background: #181818; padding: 8px; overflow-x: auto; white-space: pre-wrap; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .col h2 { margin: 4px 0; font-size: 15px; color: #fff; }
  .diff { background: #181818; padding: 8px; font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }
  .add { background: #12331a; color: #9fd6a9; display: block; }
  .del { background: #3a1518; color: #d99; text-decoration: line-through; display: block; }
  .same { color: #777; display: block; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; background: #1a1a1a; padding: 10px 16px; display: flex; gap: 10px; align-items: center; }
  button { font: inherit; padding: 8px 18px; border: 1px solid #555; background: #222; color: #eee; cursor: pointer; border-radius: 4px; }
  button:hover { background: #333; }
  input { flex: 1; font: inherit; background: #222; border: 1px solid #444; color: #eee; padding: 8px; border-radius: 4px; }
  .done { padding: 60px; text-align: center; font-size: 18px; }
</style>
<header><b>merge arena</b><span id="case"></span><span class="prog" id="prog"></span></header>
<main id="main"></main>
<footer>
  <button onclick="vote('left')">A better <small>(a)</small></button>
  <button onclick="vote('tie')">tie <small>(t)</small></button>
  <button onclick="vote('right')">B better <small>(b)</small></button>
  <input id="note" placeholder="optional note — why?">
</footer>
<script>
let cur = null;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const rowCls = { ' ': 'same', '+': 'add', '-': 'del' };
function renderDiff(d) {
  return '<div class="diff">' + d.map((r) => '<span class="' + rowCls[r.t] + '">' + esc(r.s || ' ') + '</span>').join('') + '</div>';
}
async function next() {
  const r = await fetch('/api/next'); cur = await r.json();
  document.getElementById('note').value = '';
  if (cur.done) {
    const t = await (await fetch('/api/tally')).json();
    document.getElementById('main').innerHTML = '<div class="done">All ' + t.total +
      ' comparisons voted. Run <code>node evals/arena.js &lt;runDir&gt; --tally</code> for the reveal.</div>';
    document.getElementById('case').textContent = ''; document.getElementById('prog').textContent = '';
    return;
  }
  document.getElementById('case').textContent = cur.name + ' — ' + cur.why;
  document.getElementById('prog').textContent = (cur.voted + 1) + ' / ' + cur.total;
  document.getElementById('main').innerHTML =
    '<details><summary>ledger (' + cur.messages + ' messages)</summary><pre>' + esc(cur.ledger) + '</pre></details>' +
    '<div class="cols">' +
      '<div class="col"><h2>A</h2>' + renderDiff(cur.left) + '</div>' +
      '<div class="col"><h2>B</h2>' + renderDiff(cur.right) + '</div>' +
    '</div>';
  window.scrollTo(0, 0);
}
async function vote(choice) {
  if (!cur || cur.done) return;
  const note = document.getElementById('note').value;
  const r = await fetch('/api/vote', { method: 'POST', body: JSON.stringify({ id: cur.id, choice, note }) });
  if (!r.ok) { alert('vote failed — reloading'); }
  next();
}
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'a') vote('left');
  if (e.key === 'b') vote('right');
  if (e.key === 't') vote('tie');
});
next();
</script>`;

if (require.main === module) main();
module.exports = { diffLines, tallyData };
