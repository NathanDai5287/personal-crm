'use strict';
// evals/dashboard.js — browse eval runs in a browser.
//
//   node evals/dashboard.js            # http://localhost:8788
//   CRM_EVAL_PORT=9100 node evals/dashboard.js
//
// Dependency-free, same shape as scripts/crm-web.js. No auth: it serves only
// throwaway eval artifacts from the scratch directory, never real profiles.
//
// The view that actually decides the A/B is the per-case diff: two prompts on
// the SAME profile and the SAME ledger, side by side, with every deterministic
// check next to the text that triggered it. A score tells you which prompt won;
// only the diff tells you whether you agree with the checks.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CRM_EVAL_PORT) || 8788;
const SCRATCH = process.env.CRM_EVAL_DIR
  || 'C:/Users/natha/AppData/Local/Temp/claude/C--Users-natha--openclaw/7de048dc-42ba-4c94-b38c-b7fc743ad280/scratchpad/crm-eval';

// Compaction runs live in their own scratch tree: a different prompt, a
// different scorer, and outputs that are strings rather than file edits.
const COMPACT_SCRATCH = process.env.CRM_EVAL_COMPACT_DIR
  || SCRATCH.replace(/crm-eval$/, 'crm-eval-compact');

const VARIANT_LABEL = {
  a: 'A (original)', b: 'B (rewrite)', c: 'C (B + capture)', d: 'D (K3-tuned)',
  k: 'K3 (prompt C)', kd_low: 'K3+D low', kd_high: 'K3+D high', kd_max: 'K3+D max',
  v1: 'v1 (current)', v2: 'v2 (rewrite)',
};
const SEV_ORDER = { high: 0, medium: 1, low: 2 };

// ---- compaction runs -------------------------------------------------------

function listCompactRuns() {
  if (!fs.existsSync(COMPACT_SCRATCH)) return [];
  return fs.readdirSync(COMPACT_SCRATCH)
    .filter((d) => d.startsWith('run-') && fs.existsSync(path.join(COMPACT_SCRATCH, d, 'scored.json')))
    .sort().reverse();
}

function loadCompactRun(id) {
  const dir = path.join(COMPACT_SCRATCH, id);
  const scored = JSON.parse(fs.readFileSync(path.join(dir, 'scored.json'), 'utf8'));
  let cases = [];
  try { cases = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8')); } catch { /* older run */ }
  return { id, dir, scored, cases };
}

function viewCompactRun(id) {
  const { dir, scored, cases } = loadCompactRun(id);
  const variants = [...new Set(scored.map((s) => s.variant))].sort();
  const caseNames = [...new Set(scored.map((s) => s.case))];
  const byCase = new Map(cases.map((c) => [c.name, c]));
  const L = (v) => esc(VARIANT_LABEL[v] || v);

  const totals = variants.map((v) => {
    const ss = scored.filter((s) => s.variant === v);
    return { v, got: ss.reduce((a, s) => a + s.checks.score, 0), max: ss.reduce((a, s) => a + s.checks.maxScore, 0) };
  });
  const best = Math.max(...totals.map((t) => t.got));
  const summary = `<div class="grid">${totals.map((t) => `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div class="${t.got === best ? 'win' : ''}" style="font-size:17px">${L(t.v)}</div>
        <div style="font-size:20px;font-variant-numeric:tabular-nums">${t.got}<span style="color:var(--dim);font-size:14px">/${t.max}</span></div>
      </div>${bar(t.got, t.max)}
      <div class="sub" style="margin-top:8px">${((100 * t.got) / t.max).toFixed(1)}%</div></div>`).join('')}</div>`;

  const checkIds = [...new Set(scored.flatMap((s) => s.checks.results.map((r) => r.id)))]
    .sort((a, b) => {
      const f = (x) => scored.flatMap((s) => s.checks.results).find((r) => r.id === x).severity;
      return SEV_ORDER[f(a)] - SEV_ORDER[f(b)] || a.localeCompare(b);
    });
  const matrix = `<table><tr><th>check</th><th>severity</th>${variants.map((v) => `<th>${L(v)}</th>`).join('')}</tr>
    ${checkIds.map((cid) => {
    const sev = scored.flatMap((s) => s.checks.results).find((r) => r.id === cid).severity;
    const cells = variants.map((v) => {
      const rs = scored.filter((s) => s.variant === v).flatMap((s) => s.checks.results).filter((r) => r.id === cid);
      const p = rs.filter((r) => r.pass).length;
      return `<td><span class="pill ${p === rs.length ? 'ok' : 'bad'}">${p}/${rs.length}</span></td>`;
    }).join('');
    return `<tr><td><code>${esc(cid)}</code></td><td class="sev">${esc(sev)}</td>${cells}</tr>`;
  }).join('')}</table>`;

  // The summaries ARE the artifact here — there is no file diff to show, so this
  // side-by-side is the view that actually decides the compaction A/B.
  const outputs = caseNames.map((cn) => {
    const c = byCase.get(cn);
    return `<h3 style="margin:22px 0 6px;font-size:15px">${esc(cn)}
        <span class="tag">${esc(c ? c.style : '')}</span><span class="tag">${c ? c.messages : '?'} msgs</span></h3>
      <p class="sub">${esc(c ? c.why : '')}</p>
      <div class="grid">${variants.map((v) => {
    const s = scored.find((x) => x.variant === v && x.case === cn);
    if (!s) return '<div class="card sub">—</div>';
    return `<div class="card">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <b>${L(v)}</b><span>${s.checks.score}/${s.checks.maxScore}</span></div>
          <pre>${esc(s.summary)}</pre>
          ${s.checks.failed.length ? `<div class="why" style="margin-top:8px">${s.checks.failed.map((f) => `<div><span class="pill bad">${esc(f.id)}</span> ${esc(f.detail)}</div>`).join('')}</div>` : ''}
        </div>`;
  }).join('')}</div>`;
  }).join('');

  const failures = scored.flatMap((s) => s.checks.failed.map((f) => ({ ...f, s })))
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

  return page(`compaction ${id}`, `<nav><a href="/">← all runs</a></nav>
    <h1>Compaction · ${esc(id.replace('run-', ''))}</h1>
    <p class="sub">Prompt <code>prompts/compact-v1.md</code> vs <code>compact-v2.md</code> · <code>${esc(dir)}</code></p>
    ${summary}
    <h2>Check matrix</h2>${matrix}
    <h2>Failures</h2>${failures.length ? `<table><tr><th>severity</th><th>variant</th><th>case</th><th>check</th><th>detail</th></tr>
      ${failures.map((f) => `<tr><td class="sev">${esc(f.severity)}</td><td>${L(f.s.variant)}</td><td>${esc(f.s.case)}</td>
        <td><code>${esc(f.id)}</code></td><td>${esc(f.detail)}</td></tr>`).join('')}</table>` : '<p class="sub">No failures.</p>'}
    <h2>Summaries produced</h2>${outputs}`);
}

// ---- data ----------------------------------------------------------------------

function listRuns() {
  if (!fs.existsSync(SCRATCH)) return [];
  return fs.readdirSync(SCRATCH)
    .filter((d) => d.startsWith('run-') && fs.existsSync(path.join(SCRATCH, d, 'scored.json')))
    .sort().reverse();
}

function loadRun(id) {
  const dir = path.join(SCRATCH, id);
  const scored = JSON.parse(fs.readFileSync(path.join(dir, 'scored.json'), 'utf8'));
  let cases = [];
  try { cases = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures', 'cases.json'), 'utf8')); } catch { /* older run */ }
  // A run can be judged more than once — A-vs-B and B-vs-C are separate pairwise
  // comparisons over the same outputs, so each gets its own file and its own
  // block in the UI rather than one silently overwriting the other.
  const judges = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^judge(-[a-z]{2})?\.json$/.test(x)).sort()) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      j.pair = j.pair || ['a', 'b']; // files written before pairs were recorded
      judges.push(j);
    } catch { /* unreadable */ }
  }
  return { id, dir, scored, cases, judges };
}

// A judged winner is only reported when both presentation orders agreed; a flip
// is displayed AS a flip rather than silently rounded to whichever came first.
function verdictPill(v) {
  if (!v) return '<span class="sub">—</span>';
  if (v.winner === 'tie') {
    return v.agreed ? '<span class="pill tie">tie</span>'
      : '<span class="pill tie" title="judge flipped with presentation order">tie&nbsp;*</span>';
  }
  return `<span class="pill ${v.winner === 'b' ? 'winb' : 'wina'}">${(VARIANT_LABEL[v.winner] || v.winner).split(' ')[0]}</span>`;
}

function afterText(dir, variant, caseName, slug) {
  try {
    return fs.readFileSync(path.join(dir, variant, caseName, 'sandbox', 'data', 'contacts', `${slug}.md`), 'utf8');
  } catch { return null; }
}

function replyText(dir, variant, caseName) {
  try { return fs.readFileSync(path.join(dir, variant, caseName, 'reply.txt'), 'utf8'); } catch { return ''; }
}

// ---- a small line diff (LCS) ----------------------------------------------------
// Enough to read a merge's changes; not trying to be git.

function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  // Trim the common prefix/suffix first so the DP stays small on big profiles.
  let s = 0;
  while (s < n && s < m && A[s] === B[s]) s++;
  let e = 0;
  while (e < n - s && e < m - s && A[n - 1 - e] === B[m - 1 - e]) e++;
  const midA = A.slice(s, n - e), midB = B.slice(s, m - e);

  const out = [];
  for (let i = 0; i < s; i++) out.push({ t: ' ', v: A[i] });

  const R = midA.length, C = midB.length;
  if (R * C > 4_000_000) { // pathological; fall back to block replace
    midA.forEach((v) => out.push({ t: '-', v }));
    midB.forEach((v) => out.push({ t: '+', v }));
  } else {
    const dp = Array.from({ length: R + 1 }, () => new Uint32Array(C + 1));
    for (let i = R - 1; i >= 0; i--) {
      for (let j = C - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < R && j < C) {
      if (midA[i] === midB[j]) { out.push({ t: ' ', v: midA[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', v: midA[i] }); i++; }
      else { out.push({ t: '+', v: midB[j] }); j++; }
    }
    while (i < R) { out.push({ t: '-', v: midA[i++] }); }
    while (j < C) { out.push({ t: '+', v: midB[j++] }); }
  }
  for (let i = 0; i < e; i++) out.push({ t: ' ', v: A[n - e + i] });
  return out;
}

// Collapse long runs of unchanged lines, keeping `ctx` on each side.
function condense(diff, ctx = 3) {
  const keep = new Array(diff.length).fill(false);
  diff.forEach((d, i) => {
    if (d.t === ' ') return;
    for (let k = Math.max(0, i - ctx); k <= Math.min(diff.length - 1, i + ctx); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  diff.forEach((d, i) => {
    if (keep[i]) {
      if (skipped) { out.push({ t: '@', v: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'}` }); skipped = 0; }
      out.push(d);
    } else skipped++;
  });
  if (skipped) out.push({ t: '@', v: `… ${skipped} unchanged lines` });
  return out;
}

// ---- html ----------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
:root{--bg:#fff;--fg:#16181d;--dim:#6b7280;--line:#e5e7eb;--card:#fafafa;
--ok:#0a7d32;--okbg:#e8f6ec;--bad:#b3261e;--badbg:#fdeceb;--warn:#8a6100;
--add:#e6ffed;--del:#ffeef0;--acc:#2b5cd9}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8ee;--dim:#9aa1ad;--line:#272b33;--card:#161922;
--ok:#5bd98a;--okbg:#12301d;--bad:#ff7b72;--badbg:#3a1614;--warn:#e3b341;
--add:#12301d;--del:#3a1614;--acc:#7aa2f7}}
:root[data-theme=dark]{--bg:#0f1115;--fg:#e6e8ee;--dim:#9aa1ad;--line:#272b33;--card:#161922;
--ok:#5bd98a;--okbg:#12301d;--bad:#ff7b72;--badbg:#3a1614;--warn:#e3b341;--add:#12301d;--del:#3a1614;--acc:#7aa2f7}
:root[data-theme=light]{--bg:#fff;--fg:#16181d;--dim:#6b7280;--line:#e5e7eb;--card:#fafafa;
--ok:#0a7d32;--okbg:#e8f6ec;--bad:#b3261e;--badbg:#fdeceb;--warn:#8a6100;--add:#e6ffed;--del:#ffeef0;--acc:#2b5cd9}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 20px 80px}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 10px;letter-spacing:.02em;text-transform:uppercase;color:var(--dim)}
.sub{color:var(--dim);font-size:13px;margin-bottom:8px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);font-weight:600}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}
.ok{background:var(--okbg);color:var(--ok)}.bad{background:var(--badbg);color:var(--bad)}
.tie{background:var(--line);color:var(--dim)}
.wina{background:#f3e8ff;color:#6b21a8}.winb{background:#dbeafe;color:#1e40af}
@media(prefers-color-scheme:dark){.wina{background:#2e1065;color:#d8b4fe}.winb{background:#172554;color:#93c5fd}}
:root[data-theme=dark] .wina{background:#2e1065;color:#d8b4fe}
:root[data-theme=dark] .winb{background:#172554;color:#93c5fd}
.why{font-size:12.5px;color:var(--dim);margin-top:2px}
.sev{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
.bar{height:6px;border-radius:99px;background:var(--line);overflow:hidden;min-width:90px}
.bar>i{display:block;height:100%;background:var(--ok)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
pre{font:12.5px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;margin:0;white-space:pre-wrap;word-break:break-word}
.diff{border:1px solid var(--line);border-radius:8px;overflow-x:auto;background:var(--card)}
.diff pre{white-space:pre;padding:0}
.diff .l{display:block;padding:1px 10px}
.diff .add{background:var(--add)}.diff .del{background:var(--del)}
.diff .hunk{color:var(--dim);font-style:italic;background:transparent}
.scroll{overflow-x:auto}
.tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:5px;padding:1px 6px;margin-left:6px}
.win{font-weight:700}
nav{margin-bottom:18px;font-size:13px;color:var(--dim)}
`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

function bar(got, max) {
  const pct = max ? Math.round((100 * got) / max) : 0;
  return `<div class="bar"><i style="width:${pct}%"></i></div>`;
}

function pill(pass) { return `<span class="pill ${pass ? 'ok' : 'bad'}">${pass ? 'pass' : 'FAIL'}</span>`; }

// ---- views ---------------------------------------------------------------------

function viewIndex() {
  const runs = listRuns();
  if (!runs.length) {
    return page('evals', `<h1>Merge prompt evals</h1><p class="sub">No runs yet in <code>${esc(SCRATCH)}</code>.</p>
      <p>Run <code>node evals/run.js</code> first.</p>`);
  }
  const compactRows = listCompactRuns().map((id) => {
    const { scored } = loadCompactRun(id);
    const vs = [...new Set(scored.map((s) => s.variant))].sort();
    const cells = vs.map((v) => {
      const ss = scored.filter((s) => s.variant === v);
      const got = ss.reduce((a, s) => a + s.checks.score, 0);
      const max = ss.reduce((a, s) => a + s.checks.maxScore, 0);
      return `${esc(VARIANT_LABEL[v] || v)}: <b>${got}/${max}</b>`;
    }).join(' &nbsp;·&nbsp; ');
    return `<tr><td><a href="/compact/${encodeURIComponent(id)}">${esc(id.replace('run-', ''))}</a></td>
      <td class="sub">compaction</td><td>${cells}</td><td class="num">${scored.length} calls</td></tr>`;
  }).join('');

  const rows = runs.map((id) => {
    const { scored } = loadRun(id);
    const vs = [...new Set(scored.map((s) => s.variant))].sort();
    const cells = vs.map((v) => {
      const ss = scored.filter((s) => s.variant === v);
      const got = ss.reduce((a, s) => a + s.checks.score, 0);
      const max = ss.reduce((a, s) => a + s.checks.maxScore, 0);
      return `${VARIANT_LABEL[v] || v}: <b>${got}/${max}</b>`;
    }).join(' &nbsp;·&nbsp; ');
    const model = scored[0] ? scored[0].model : '';
    return `<tr><td><a href="/run/${encodeURIComponent(id)}">${esc(id.replace('run-', ''))}</a></td>
      <td>${esc(model)}</td><td>${cells}</td><td class="num">${scored.length} runs</td></tr>`;
  }).join('');
  return page('evals', `<h1>Prompt evals</h1>
    <p class="sub">Deterministic scoring plus a blind, order-swapped semantic judge.
      Every variant is graded against one written-down contract, not against another prompt's wording.</p>
    <h2>Merge prompt</h2>
    <table><tr><th>run</th><th>model</th><th>totals</th><th class="num"></th></tr>${rows}</table>
    <h2>Compaction prompt</h2>
    ${compactRows ? `<table><tr><th>run</th><th>kind</th><th>totals</th><th class="num"></th></tr>${compactRows}</table>`
    : '<p class="sub">No compaction runs yet — <code>node evals/compact-run.js</code>.</p>'}`);
}

function viewRun(id) {
  const { dir, scored, cases } = loadRun(id);
  const variants = [...new Set(scored.map((s) => s.variant))].sort();
  const caseNames = [...new Set(scored.map((s) => s.case))];
  const byCase = new Map(cases.map((c) => [c.name, c]));

  const totals = variants.map((v) => {
    const ss = scored.filter((s) => s.variant === v);
    return { v, got: ss.reduce((a, s) => a + s.checks.score, 0), max: ss.reduce((a, s) => a + s.checks.maxScore, 0),
      secs: Math.round(ss.reduce((a, s) => a + s.elapsed, 0) / 1000) };
  });
  const best = Math.max(...totals.map((t) => t.got));

  const summary = `<div class="grid">${totals.map((t) => `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div class="${t.got === best ? 'win' : ''}" style="font-size:17px">${VARIANT_LABEL[t.v] || t.v}</div>
        <div style="font-size:20px;font-variant-numeric:tabular-nums">${t.got}<span style="color:var(--dim);font-size:14px">/${t.max}</span></div>
      </div>
      ${bar(t.got, t.max)}
      <div class="sub" style="margin-top:8px">${((100 * t.got) / t.max).toFixed(1)}% · ${t.secs}s total</div>
    </div>`).join('')}</div>`;

  // Check matrix: one row per check, pass-count per variant.
  const checkIds = [...new Set(scored.flatMap((s) => s.checks.results.map((r) => r.id)))]
    .sort((a, b) => {
      const sa = scored.flatMap((s) => s.checks.results).find((r) => r.id === a).severity;
      const sb = scored.flatMap((s) => s.checks.results).find((r) => r.id === b).severity;
      return SEV_ORDER[sa] - SEV_ORDER[sb] || a.localeCompare(b);
    });
  const matrix = `<table><tr><th>check</th><th>severity</th>${variants.map((v) => `<th>${esc(VARIANT_LABEL[v] || v)}</th>`).join('')}</tr>
    ${checkIds.map((cid) => {
    const sev = scored.flatMap((s) => s.checks.results).find((r) => r.id === cid).severity;
    const cells = variants.map((v) => {
      const rs = scored.filter((s) => s.variant === v).flatMap((s) => s.checks.results).filter((r) => r.id === cid);
      const p = rs.filter((r) => r.pass).length;
      return `<td>${p === rs.length ? `<span class="pill ok">${p}/${rs.length}</span>` : `<span class="pill bad">${p}/${rs.length}</span>`}</td>`;
    }).join('');
    return `<tr><td><code>${esc(cid)}</code></td><td class="sev">${esc(sev)}</td>${cells}</tr>`;
  }).join('')}</table>`;

  const caseRows = caseNames.map((cn) => {
    const c = byCase.get(cn);
    const cells = variants.map((v) => {
      const s = scored.find((x) => x.variant === v && x.case === cn);
      if (!s) return '<td>—</td>';
      const fails = s.checks.failed.length;
      return `<td>${s.checks.score}/${s.checks.maxScore} ${fails ? `<span class="pill bad">${fails} fail</span>` : '<span class="pill ok">clean</span>'}</td>`;
    }).join('');
    return `<tr><td><a href="/run/${encodeURIComponent(id)}/case/${encodeURIComponent(cn)}">${esc(cn)}</a>
        <div class="sub">${esc(c ? c.why : '')}</div></td>
      <td class="num">${c ? c.messages : ''}</td>${cells}</tr>`;
  }).join('');

  const failures = scored.flatMap((s) => s.checks.failed.map((f) => ({ ...f, s })))
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const failList = failures.length ? `<table><tr><th>severity</th><th>variant</th><th>case</th><th>check</th><th>detail</th></tr>
    ${failures.map((f) => `<tr><td class="sev">${esc(f.severity)}</td><td>${esc(VARIANT_LABEL[f.s.variant] || f.s.variant)}</td>
      <td><a href="/run/${encodeURIComponent(id)}/case/${encodeURIComponent(f.s.case)}">${esc(f.s.case)}</a></td>
      <td><code>${esc(f.id)}</code></td><td>${esc(f.detail)}</td></tr>`).join('')}</table>`
    : '<p class="sub">No failures.</p>';

  // ---- semantic judgment (one block per judged pair) ----
  const { judges } = loadRun(id);
  let judgeBlock = judges.length ? '' : `<p class="sub">Not judged yet. Run <code>node evals/judge.js ${esc(id)}</code>.</p>`;
  for (const judge of judges) {
    if (!judge.results.length) continue;
    const dims = judge.dimensions;
    const [P1, P2] = judge.pair;
    const tally = { [P1]: 0, [P2]: 0, tie: 0 };
    for (const r of judge.results) for (const d of dims) tally[r.dimensions[d].winner]++;
    const ov = { [P1]: 0, [P2]: 0, tie: 0 };
    for (const r of judge.results) ov[r.overall.winner]++;
    const flips = judge.results.reduce((n, r) => n + dims.filter((d) => !r.dimensions[d].agreed).length, 0);
    const L = (v) => esc(VARIANT_LABEL[v] || v);

    judgeBlock += `<h3 style="margin:22px 0 6px;font-size:15px">${L(P1)} vs ${L(P2)}</h3>
      <p class="sub">Blind pairwise, judged by <code>${esc(judge.model)}</code> in both presentation orders.
      A verdict counts only when both orders agree; a flip is recorded as a tie and marked <b>*</b>.</p>
      <table><tr><th>case</th>${dims.map((d) => `<th>${esc(d.replace(/_/g, ' '))}</th>`).join('')}<th>overall</th></tr>
      ${judge.results.map((r) => `<tr>
        <td><a href="/run/${encodeURIComponent(id)}/case/${encodeURIComponent(r.case)}">${esc(r.case)}</a></td>
        ${dims.map((d) => `<td>${verdictPill(r.dimensions[d])}</td>`).join('')}
        <td>${verdictPill(r.overall)}</td></tr>`).join('')}
      </table>
      <p class="sub" style="margin-top:10px">dimension wins — <b>${L(P1)} ${tally[P1]}</b> · <b>${L(P2)} ${tally[P2]}</b> · tie ${tally.tie}
        (of ${judge.results.length * dims.length}) &nbsp;·&nbsp; overall — <b>${L(P1)} ${ov[P1]}</b> · <b>${L(P2)} ${ov[P2]}</b> · tie ${ov.tie}
        &nbsp;·&nbsp; ${flips} order-flip${flips === 1 ? '' : 's'}</p>`;

    const unsup = judge.results.flatMap((r) => r.unsupported.map((u) => ({ ...u, case: r.case })));
    judgeBlock += unsup.length
      ? `<table><tr><th>unsupported claim flagged against</th><th>case</th><th>pass</th><th>claim</th></tr>
        ${unsup.map((u) => `<tr><td><span class="pill ${u.variant === P2 ? 'winb' : 'wina'}">${L(u.variant)}</span></td>
          <td>${esc(u.case)}</td><td class="sub">${esc(u.pass)}</td><td>${esc(u.claim)}</td></tr>`).join('')}</table>`
      : '<p class="sub">No unsupported claims flagged in either variant.</p>';
  }

  return page(`eval ${id}`, `<nav><a href="/">← all runs</a></nav>
    <h1>${esc(id.replace('run-', ''))}</h1>
    <p class="sub">model <code>${esc(scored[0] ? scored[0].model : '')}</code> · ${scored.length} runs · <code>${esc(dir)}</code></p>
    ${summary}
    <h2>Semantic judgment</h2>${judgeBlock}
    <h2>Check matrix</h2>${matrix}
    <h2>Per case</h2><table><tr><th>case</th><th class="num">msgs</th>${variants.map((v) => `<th>${esc(VARIANT_LABEL[v] || v)}</th>`).join('')}</tr>${caseRows}</table>
    <h2>Failures</h2>${failList}`);
}

function renderDiff(before, after) {
  if (after === null) return '<p class="sub">no output</p>';
  if (before === after) return '<p class="sub">profile unchanged (no edit made)</p>';
  const d = condense(diffLines(before, after));
  return `<div class="diff"><pre>${d.map((l) => {
    const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '@' ? 'hunk' : '';
    const prefix = l.t === '@' ? '' : l.t;
    return `<span class="l ${cls}">${esc(prefix + l.v)}</span>`;
  }).join('')}</pre></div>`;
}

function judgeBlocksForCase(judges, caseName) {
  return (judges || []).map((j) => judgeBlockForCase(j, caseName)).filter(Boolean).join('');
}

function judgeBlockForCase(judge, caseName) {
  if (!judge) return '';
  const r = judge.results.find((x) => x.case === caseName);
  if (!r) return '';
  const [P1, P2] = judge.pair || ['a', 'b'];
  const L = (v) => esc(VARIANT_LABEL[v] || v);
  const rows = judge.dimensions.map((d) => {
    const v = r.dimensions[d];
    return `<tr><td>${verdictPill(v)}</td><td><b>${esc(d.replace(/_/g, ' '))}</b>
      <div class="why">${esc(v.why)}</div>
      ${v.agreed ? '' : `<div class="why"><i>reversed order said ${esc(v.reverse === 'tie' ? 'tie' : (VARIANT_LABEL[v.reverse] || v.reverse))} — ${esc(v.whyReverse)}</i></div>`}
      </td></tr>`;
  }).join('');
  const unsup = r.unsupported.length
    ? `<div class="card" style="margin-top:10px"><b>Unsupported claims flagged</b>
       ${r.unsupported.map((u) => `<div class="why"><span class="pill ${u.variant === P2 ? 'winb' : 'wina'}">${L(u.variant)}</span> ${esc(u.claim)}</div>`).join('')}</div>`
    : '';
  return `<h2>Semantic judgment — ${L(P1)} vs ${L(P2)}</h2>
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;align-items:center"><b>Overall</b> ${verdictPill(r.overall)}</div>
      <div class="why">${esc(r.overall.why)}</div>
      ${r.overall.agreed ? '' : `<div class="why"><i>reversed order said ${esc(r.overall.reverse === 'tie' ? 'tie' : (VARIANT_LABEL[r.overall.reverse] || r.overall.reverse))} — ${esc(r.overall.whyReverse)}</i></div>`}
    </div>
    <table>${rows}</table>${unsup}`;
}

function viewCase(id, caseName) {
  const { dir, scored, cases, judges } = loadRun(id);
  const c = cases.find((x) => x.name === caseName);
  const runs = scored.filter((s) => s.case === caseName).sort((a, b) => a.variant.localeCompare(b.variant));
  if (!runs.length) return page('not found', `<nav><a href="/run/${encodeURIComponent(id)}">← back</a></nav><p>No runs scored for case <code>${esc(caseName)}</code>.</p>`);
  if (!c) {
    // Runs from before fixtures were persisted. The scores are still valid; only
    // the before/after diff is unavailable, so say so instead of 404ing.
    return page('no fixture', `<nav><a href="/run/${encodeURIComponent(id)}">← back</a></nav>
      <h1>${esc(caseName)}</h1>
      <p class="sub">This run predates fixture persistence, so the original profile isn't stored and no diff can be shown.
      Re-run <code>node evals/backfill-fixtures.js ${esc(id)}</code> to reconstruct it.</p>
      ${runs.map((s) => `<div class="card" style="margin-bottom:12px"><b>${esc(VARIANT_LABEL[s.variant] || s.variant)}</b> — ${s.checks.score}/${s.checks.maxScore}
        <table>${s.checks.results.map((r) => `<tr><td>${pill(r.pass)}</td><td><code>${esc(r.id)}</code><div class="sub">${esc(r.detail)}</div></td></tr>`).join('')}</table></div>`).join('')}`);
  }

  const panels = runs.map((s) => {
    const after = afterText(dir, s.variant, caseName, s.slug);
    const checks = [...s.checks.results].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.id.localeCompare(b.id));
    return `<div>
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <b style="font-size:16px">${esc(VARIANT_LABEL[s.variant] || s.variant)}</b>
          <span style="font-size:18px;font-variant-numeric:tabular-nums">${s.checks.score}/${s.checks.maxScore}</span>
        </div>${bar(s.checks.score, s.checks.maxScore)}
        <div class="sub" style="margin-top:8px">${(s.elapsed / 1000).toFixed(0)}s${s.ok ? '' : ' · <b style="color:var(--bad)">invocation failed</b>'}</div>
      </div>
      <table>${checks.map((r) => `<tr><td>${pill(r.pass)}</td><td><code>${esc(r.id)}</code>
        <div class="sub">${esc(r.detail)}</div></td></tr>`).join('')}</table>
      <h2>Model reply</h2><div class="card"><pre>${esc(replyText(dir, s.variant, caseName).trim() || '(empty)')}</pre></div>
      <h2>Profile diff</h2>${c.unverified
    ? '<p class="sub">Fixture could not be verified against the sandbox — diff suppressed rather than shown wrong.</p>'
    : renderDiff(c.profile, after)}
    </div>`;
  }).join('');

  return page(`${caseName} — eval`, `<nav><a href="/">all runs</a> · <a href="/run/${encodeURIComponent(id)}">← ${esc(id.replace('run-', ''))}</a></nav>
    <h1>${esc(caseName)} <span class="tag">${esc(c.slug)}</span></h1>
    <p class="sub">${esc(c.why)} · ${c.messages} messages · ledger ${esc(c.chunkLabel || '')}</p>
    ${judgeBlocksForCase(judges, caseName)}
    <div class="grid">${panels}</div>
    <h2>Ledger fed to both</h2><div class="card scroll"><pre>${esc(c.ledger)}</pre></div>`);
}

// ---- server --------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const send = (html, code = 200) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  };
  const known = (id) => listRuns().includes(id);
  try {
    if (parts.length === 0) return send(viewIndex());
    if (parts[0] === 'run' && parts.length >= 2 && !known(parts[1])) {
      return send(page('404', `<h1>No such run</h1><p><code>${esc(parts[1])}</code> is not in <code>${esc(SCRATCH)}</code>. <a href="/">Back</a></p>`), 404);
    }
    if (parts[0] === 'compact' && parts.length === 2) {
      if (!listCompactRuns().includes(parts[1])) return send(page('404', `<h1>No such compaction run</h1><p><a href="/">Back</a></p>`), 404);
      return send(viewCompactRun(parts[1]));
    }
    if (parts[0] === 'run' && parts.length === 2) return send(viewRun(parts[1]));
    if (parts[0] === 'run' && parts[2] === 'case' && parts.length === 4) return send(viewCase(parts[1], parts[3]));
    return send(page('404', '<p>Not found. <a href="/">Back</a></p>'), 404);
  } catch (e) {
    return send(page('error', `<h1>Error</h1><pre>${esc(e.stack || e.message)}</pre>`), 500);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — an older dashboard is probably still running.\n` +
      `Stop it, or pick another port:  CRM_EVAL_PORT=${PORT + 1} node evals/dashboard.js`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`eval dashboard  http://localhost:${PORT}`);
  console.log(`reading runs from ${SCRATCH}`);
});
