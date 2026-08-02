'use strict';
// evals/estimate.js — what would this run cost, before spending anything.
//
//   node evals/estimate.js --variant k
//   node evals/estimate.js --variant c,k --fixtures-from <runId>
//
// Sends nothing. Measures the real fixtures, prices them against pi's own model
// catalog (~/.pi/agent/models-store.json — the same table pi bills from), and
// prints a low/high band.
//
// WHY A BAND AND NOT A NUMBER: two things are genuinely unknown before the fact.
// (1) The agentic loop resends the conversation each turn, so billed input is
// roughly input x turns, and turn count varies with how much the model fumbles.
// (2) Reasoning tokens bill as OUTPUT, and thinking level 'high' can spend more
// on thinking than on the edit. Anyone quoting a single number for this is
// guessing; the honest output is a range plus the assumptions that produced it.

const fs = require('fs');
const path = require('path');

const SCRATCH = process.env.CRM_EVAL_DIR
  || 'C:/Users/natha/AppData/Local/Temp/claude/C--Users-natha--openclaw/7de048dc-42ba-4c94-b38c-b7fc743ad280/scratchpad/crm-eval';
const STORE = path.join(process.env.USERPROFILE || process.env.HOME, '.pi', 'agent', 'models-store.json');

// The repo's own estimator constant (lib/weeks.js), kept identical so chunk
// planning and cost estimation never disagree about what a token is.
const CHARS_PER_TOKEN = 2.4;

// pi's harness overhead: tool schemas for read+edit, plus its agent preamble.
// Measured indirectly; treated as a fixed adder per turn.
const SCAFFOLD_TOKENS = 2_000;

// Turns in the agentic loop. Floor: read the ledger, emit one edit, confirm.
// Ceiling: re-read the profile, several edits, a verification pass.
const TURNS_LOW = 2;
const TURNS_HIGH = 4;

// Output per call, INCLUDING reasoning. Floor assumes a terse edit and light
// thinking; ceiling assumes a full rewrite of three sections at thinking=high.
const OUT_LOW = 2_500;
const OUT_HIGH = 9_000;

const tok = (s) => Math.round(String(s).length / CHARS_PER_TOKEN);

function priceOf(modelId) {
  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  let found = null;
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (o.id === modelId && o.cost) found = o;
      Object.values(o).forEach(walk);
    }
  };
  walk(store);
  if (!found) throw new Error(`model '${modelId}' not in ${STORE}`);
  return { cost: found.cost, name: found.name, ctx: found.contextWindow };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

  const { VARIANTS } = require('./run');
  const keys = (arg('--variant', 'k')).split(',').map((x) => x.trim()).filter(Boolean);
  const globalModel = arg('--model', 'anthropic/claude-opus-5');

  const from = arg('--fixtures-from', null);
  let cases;
  if (from) {
    const dir = fs.existsSync(from) ? from : path.join(SCRATCH, from);
    cases = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures', 'cases.json'), 'utf8'));
  } else {
    const runs = fs.existsSync(SCRATCH)
      ? fs.readdirSync(SCRATCH).filter((d) => fs.existsSync(path.join(SCRATCH, d, 'fixtures', 'cases.json'))).sort()
      : [];
    if (!runs.length) { console.error('no fixtures found; pass --fixtures-from <runId>'); process.exit(1); }
    cases = JSON.parse(fs.readFileSync(path.join(SCRATCH, runs[runs.length - 1], 'fixtures', 'cases.json'), 'utf8'));
    console.log(`(using fixtures from ${runs[runs.length - 1]})\n`);
  }

  let grandLow = 0, grandHigh = 0;
  for (const k of keys) {
    const v = VARIANTS[k];
    if (!v) { console.error(`unknown variant '${k}'`); process.exit(2); }
    const modelId = (v.model || globalModel).split('/').pop();
    const free = (v.model || globalModel).startsWith('anthropic/');
    let price;
    try { price = priceOf(modelId); } catch (e) { console.error(e.message); process.exit(1); }
    const sys = tok(fs.readFileSync(path.resolve(__dirname, '..', v.prompt), 'utf8'));

    console.log(`${v.label}  —  ${v.model || globalModel}${free ? '   (subscription auth: $0 regardless of tokens)' : ''}`);
    console.log(`  prompt ${v.prompt} = ${sys.toLocaleString()} tok · price in $${price.cost.input}/M, out $${price.cost.output}/M\n`);
    console.log(`  ${'case'.padEnd(15)}${'profile'.padStart(9)}${'ledger'.padStart(9)}${'1-turn in'.padStart(11)}${'low $'.padStart(9)}${'high $'.padStart(9)}`);

    let lo = 0, hi = 0;
    for (const c of cases) {
      const p = tok(c.profile), l = tok(c.ledger);
      const perTurn = sys + p + l + SCAFFOLD_TOKENS + 100; // +100 user turn
      const inLow = perTurn * TURNS_LOW, inHigh = perTurn * TURNS_HIGH;
      const cLow = (inLow * price.cost.input + OUT_LOW * price.cost.output) / 1e6;
      const cHigh = (inHigh * price.cost.input + OUT_HIGH * price.cost.output) / 1e6;
      lo += cLow; hi += cHigh;
      console.log(`  ${c.name.padEnd(15)}${p.toLocaleString().padStart(9)}${l.toLocaleString().padStart(9)}` +
        `${perTurn.toLocaleString().padStart(11)}${(free ? 0 : cLow).toFixed(3).padStart(9)}${(free ? 0 : cHigh).toFixed(3).padStart(9)}`);
    }
    if (free) { lo = 0; hi = 0; }
    grandLow += lo; grandHigh += hi;
    console.log(`  ${''.padEnd(15)}${''.padStart(9)}${''.padStart(9)}${'TOTAL'.padStart(11)}${lo.toFixed(2).padStart(9)}${hi.toFixed(2).padStart(9)}\n`);
  }

  console.log('='.repeat(64));
  console.log(`ESTIMATE for ${keys.join(',')} over ${cases.length} case(s):  $${grandLow.toFixed(2)} – $${grandHigh.toFixed(2)}`);
  console.log(`assumptions: ${TURNS_LOW}–${TURNS_HIGH} agentic turns, ${OUT_LOW.toLocaleString()}–${OUT_HIGH.toLocaleString()} output tok/call`);
  console.log('             (output includes reasoning; thinking=high can dominate)');
  console.log('             no prompt caching assumed — cacheRead would cut input ~10x');
}

if (require.main === module) main();
