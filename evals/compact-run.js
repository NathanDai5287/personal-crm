'use strict';
// evals/compact-run.js — A/B the compaction prompt over real archive buckets.
//
//   node evals/compact-run.js                          # all variants, Opus 5, free
//   node evals/compact-run.js --variant v1
//   node evals/compact-run.js --estimate               # price it, send nothing
//   node evals/compact-run.js --score-only <runDir>    # re-score cached output
//
// Same cost guard as evals/run.js: a non-anthropic model is REFUSED unless
// --allow-paid. Same reason the merge harness drives crm-merge.js rather than
// reimplementing it, this drives lib/compact-prompt.js + the real pi invocation,
// so what is measured is what ships.
//
// No sandbox is needed here: compaction has no tools and edits no files. Its
// entire output is the returned string, which is also its entire risk surface.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PI_CLI } = require('../lib/config');
const { render, loadTemplate } = require('../lib/compact-prompt');
const { buildFixtures } = require('./compact-cases');
const { runChecks } = require('./compact-checks');

const SCRATCH = process.env.CRM_EVAL_DIR
  || 'C:/Users/natha/AppData/Local/Temp/claude/C--Users-natha--openclaw/7de048dc-42ba-4c94-b38c-b7fc743ad280/scratchpad/crm-eval-compact';
const FREE_PREFIX = 'anthropic/';
const DEFAULT_MODEL = 'anthropic/claude-opus-5';
const CHARS_PER_TOKEN = 2.4;

const STYLE_INSTRUCTION = {
  daily: 'Summarize the day in ONE concise line: what was discussed/done, plus any durable facts (plans, decisions, life events). Past tense, no preamble.',
  weekly: 'Summarize the period in 1-2 concise lines: the main threads and any durable facts. Past tense, no preamble.',
};

const VARIANTS = {
  v1: { label: 'v1 (current)', prompt: 'prompts/compact-v1.md' },
  v2: { label: 'v2 (rewrite)', prompt: 'prompts/compact-v2.md' },
};

function buildPrompt(c, variantKey) {
  const tpl = loadTemplate(path.resolve(__dirname, '..', VARIANTS[variantKey].prompt));
  return render(tpl, {
    PERIOD_SENTENCE: `These are Signal messages ${c.who} during ${c.periodLabel}.`,
    STYLE_INSTRUCTION: STYLE_INSTRUCTION[c.style] || STYLE_INSTRUCTION.weekly,
    MESSAGES: c.lines.join('\n'),
  });
}

// Prompt goes on stdin exactly as crm-compact.js sends it — not as argv, which
// would hit the same ~32KB Windows limit that broke the merge judge.
function callModel(user, system, model) {
  const argv = [PI_CLI, '-p', '--no-session', '-nc', '--no-extensions', '--no-skills', '--no-tools', '--model', model];
  if (system) argv.push('--system-prompt', system);
  try {
    const out = execFileSync(process.execPath, argv, {
      input: user,
      cwd: require('os').tmpdir(),
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' },
    });
    return { ok: true, text: out.trim() };
  } catch (e) {
    return { ok: false, text: `(summary failed: ${String(e && e.message || e).slice(0, 120)})` };
  }
}

const pad = (s, n) => String(s).padEnd(n);
const tok = (s) => Math.round(String(s).length / CHARS_PER_TOKEN);

function estimate(cases, variants) {
  console.log(`\n${pad('case', 16)}${pad('style', 9)}${'msgs'.padStart(6)}${'prompt tok'.padStart(12)}`);
  let total = 0;
  for (const c of cases) {
    const { user, system } = buildPrompt(c, variants[0]);
    const t = tok(user) + tok(system || '');
    total += t;
    console.log(`${pad(c.name, 16)}${pad(c.style, 9)}${String(c.messages).padStart(6)}${t.toLocaleString().padStart(12)}`);
  }
  const perVariant = total;
  console.log(`\ninput tokens per variant: ~${perVariant.toLocaleString()} (x${variants.length} variant(s) = ${(perVariant * variants.length).toLocaleString()})`);
  console.log('output is short by construction (1-2 lines), so cost is input-dominated.');
  console.log(`on kimi-k3 ($3/M in, $15/M out): ~$${((perVariant * variants.length * 3) / 1e6 + (cases.length * variants.length * 600 * 15) / 1e6).toFixed(3)} for a single pass`);
  console.log('on anthropic/*: $0 (subscription auth)');
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const model = arg('--model', DEFAULT_MODEL);
  const onlyVariant = arg('--variant', null);
  const onlyCase = arg('--case', null);
  const scoreOnly = arg('--score-only', null);

  let variants = onlyVariant ? onlyVariant.split(',').map((s) => s.trim()) : Object.keys(VARIANTS);
  variants = variants.filter((v) => {
    if (!VARIANTS[v]) { console.error(`unknown variant '${v}'`); process.exit(2); }
    const p = path.resolve(__dirname, '..', VARIANTS[v].prompt);
    if (!fs.existsSync(p)) { console.log(`skipping ${v}: ${VARIANTS[v].prompt} does not exist yet`); return false; }
    return true;
  });
  if (!variants.length) { console.error('no runnable variants'); process.exit(1); }

  console.log('building fixtures from the archive…');
  let cases = buildFixtures();
  if (onlyCase) cases = cases.filter((c) => c.name === onlyCase);
  if (!cases.length) { console.error('no fixtures'); process.exit(1); }

  if (argv.includes('--estimate')) { estimate(cases, variants); return; }

  if (!model.startsWith(FREE_PREFIX) && !argv.includes('--allow-paid')) {
    console.error(`REFUSING to run '${model}': bills per token. Re-run with --allow-paid if intended.`);
    process.exit(2);
  }

  const runDir = scoreOnly || path.join(SCRATCH, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'cases.json'), JSON.stringify(cases, null, 2));

  console.log(`\n${cases.length} case(s) x ${variants.length} variant(s) = ${cases.length * variants.length} call(s)`);
  console.log(`model: ${model}${model.startsWith(FREE_PREFIX) ? '  (subscription — free)' : '  ** PAID **'}\n`);
  for (const c of cases) console.log(`  ${pad(c.name, 16)}${pad(c.style, 9)}${String(c.messages).padStart(5)} msgs   ${c.why}`);
  console.log('');

  const scored = [];
  for (const c of cases) {
    for (const v of variants) {
      const dir = path.join(runDir, v);
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `${c.name}.txt`);
      let summary;
      if (scoreOnly) {
        summary = fs.readFileSync(out, 'utf8');
      } else {
        process.stdout.write(`run ${pad(`${v}/${c.name}`, 24)} … `);
        const { user, system } = buildPrompt(c, v);
        fs.writeFileSync(path.join(dir, `${c.name}.prompt.txt`), (system ? `[SYSTEM]\n${system}\n\n[USER]\n` : '') + user);
        const started = Date.now();
        const res = callModel(user, system, model);
        summary = res.text;
        fs.writeFileSync(out, summary);
        console.log(`${res.ok ? 'ok' : 'FAILED'}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
      }
      const checks = runChecks({
        summary, inputLines: c.lines.join('\n'), style: c.style,
        canary: c.canary, expectThin: c.expectThin,
      });
      scored.push({ case: c.name, variant: v, style: c.style, summary, checks });
    }
  }
  fs.writeFileSync(path.join(runDir, 'scored.json'), JSON.stringify(scored, null, 2));

  // ---- report ----
  const ids = [...new Set(scored.flatMap((s) => s.checks.results.map((r) => r.id)))];
  console.log('\n================ CHECK MATRIX ================\n');
  const head = `${pad('check', 24)}${variants.map((v) => pad(`  ${VARIANTS[v].label}`, 18)).join('')}`;
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const id of ids) {
    const sev = scored.flatMap((s) => s.checks.results).find((r) => r.id === id).severity;
    const cells = variants.map((v) => {
      const rs = scored.filter((s) => s.variant === v).flatMap((s) => s.checks.results).filter((r) => r.id === id);
      const p = rs.filter((r) => r.pass).length;
      return pad(`  ${p}/${rs.length}${p === rs.length ? ' ok' : ' FAIL'}`, 18);
    });
    console.log(`${pad(`${id} [${sev[0]}]`, 24)}${cells.join('')}`);
  }

  console.log('\n================ PER-CASE ================\n');
  console.log(`${pad('case', 16)}${variants.map((v) => pad(VARIANTS[v].label, 18)).join('')}`);
  for (const c of cases) {
    const cells = variants.map((v) => {
      const s = scored.find((x) => x.variant === v && x.case === c.name);
      return pad(s ? `${s.checks.score}/${s.checks.maxScore}` : '—', 18);
    });
    console.log(`${pad(c.name, 16)}${cells.join('')}`);
  }
  console.log('');
  for (const v of variants) {
    const ss = scored.filter((s) => s.variant === v);
    const got = ss.reduce((a, s) => a + s.checks.score, 0);
    const max = ss.reduce((a, s) => a + s.checks.maxScore, 0);
    console.log(`${pad(VARIANTS[v].label, 18)} ${got}/${max}  (${(100 * got / max).toFixed(1)}%)`);
  }

  console.log('\n================ FAILURES ================\n');
  let any = false;
  for (const s of scored) for (const f of s.checks.failed) {
    any = true;
    console.log(`[${f.severity.toUpperCase().padEnd(6)}] ${pad(VARIANTS[s.variant].label, 15)} ${pad(s.case, 15)} ${pad(f.id, 22)} ${f.detail}`);
  }
  if (!any) console.log('(none)');

  console.log('\n================ SUMMARIES ================');
  for (const c of cases) {
    console.log(`\n--- ${c.name} (${c.style}, ${c.messages} msgs) ---`);
    for (const v of variants) {
      const s = scored.find((x) => x.variant === v && x.case === c.name);
      if (s) console.log(`  [${v}] ${s.summary.replace(/\n/g, '\n        ')}`);
    }
  }
  console.log(`\nartifacts: ${runDir}`);
}

if (require.main === module) main();
module.exports = { VARIANTS, buildPrompt };
