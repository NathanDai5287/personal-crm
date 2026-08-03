'use strict';
// evals/tasks-run.js — score a commitment-extraction prompt against hand-labelled gold.
//
//   node evals/tasks-run.js                       # production prompt
//   node evals/tasks-run.js --variant v1,v2,v3    # compare variants
//   node evals/tasks-run.js --case katia-jacoby
//
// WHY THIS IS NOT SHAPED LIKE THE MERGE EVAL: a merge produces prose, so its checks can
// only score MECHANISM (right file, intact Timeline, real citations) and ranking needs
// a judge. This produces JSON with a message id attached, so correctness is a set
// comparison against labels — exact, cheap, and with real headroom. The merge checks
// saturated twice; precision and recall cannot, because they are measured against
// something outside the prompt's control.
//
// THE PRIMARY METRIC IS PRECISION. Nathan's instruction was that a todo list of vague
// non-actions is worse than an empty one, so a false positive costs more than a miss.
// Recall is reported to catch the opposite failure — a prompt so strict it extracts
// nothing is also useless, and V1 already returns 0 on some real ledgers.
//
// PRECISION IS ALSO SPLIT BY `confidence`. If `explicit` and `probable` score the same,
// the field is decorative and should be cut rather than shown in the UI as if it meant
// something.
//
// Cost: anthropic/* runs on the subscription, so free. Refuses a paid model without
// --allow-paid, same guard as the other runners.

const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/config');
const { extractFor } = require('../scripts/crm-tasks');
const { parseGold, LEDGER_DIR, GOLD_DIR, GOLD_CONTACTS } = require('./tasks-fixtures');

const FREE_PREFIX = 'anthropic/';
const DEFAULT_MODEL = 'anthropic/claude-opus-5';

const VARIANTS = {
  v1: { label: 'V1 (production)', prompt: 'prompts/tasks.md' },
  v2: { label: 'V2 (recall-leaning)', prompt: 'prompts/tasks-v2.md' },
  v3: { label: 'V3 (strict)', prompt: 'prompts/tasks-v3.md' },
};

// The fixture is frozen and anchored to its own last message, so "today" must be too.
// Passing wall-clock would make every deadline in the output drift day by day and the
// run would stop being reproducible.
function todayFor(ledgerFile) {
  const head = fs.readFileSync(ledgerFile, 'utf8').slice(0, 400);
  const m = /—\s*(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(head);
  return m ? m[2] : new Date().toISOString().slice(0, 10);
}

function score(extracted, gold) {
  const got = new Set(extracted.map((t) => t.msgId));
  const tp = [...got].filter((id) => gold.yes.has(id));
  const fp = [...got].filter((id) => !gold.yes.has(id));
  const fn = [...gold.yes].filter((id) => !got.has(id));
  const p = got.size ? tp.length / got.size : null;      // null, not 1 — see report()
  const r = gold.yes.size ? tp.length / gold.yes.size : null;
  const f1 = (p && r) ? (2 * p * r) / (p + r) : (p === null || r === null ? null : 0);
  return { tp, fp, fn, precision: p, recall: r, f1, emitted: got.size, goldSize: gold.yes.size };
}

// A false positive is only interesting if you can see WHY the model thought it was a
// commitment, so every one is printed with the line it cites.
function ledgerLine(ledgerFile, id) {
  const re = new RegExp(`^\\[[^\\]]+\\] ⟨m${id}⟩ (.*)$`, 'm');
  const m = re.exec(fs.readFileSync(ledgerFile, 'utf8'));
  return m ? m[1].slice(0, 110) : '(not in ledger)';
}

function pct(x) { return x === null ? '  n/a' : `${(x * 100).toFixed(1)}%`.padStart(6); }

function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

  const VALUE_FLAGS = ['--variant', '--case', '--model'];
  const BOOL_FLAGS = ['--allow-paid', '--verbose'];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (BOOL_FLAGS.includes(a)) continue;
    if (VALUE_FLAGS.includes(a)) { i += 1; continue; }
    console.error(`unknown flag '${a}'\nknown: ${[...VALUE_FLAGS.map((f) => `${f} <value>`), ...BOOL_FLAGS].join(', ')}`);
    process.exit(2);
  }

  const model = arg('--model', DEFAULT_MODEL);
  if (!model.startsWith(FREE_PREFIX) && !argv.includes('--allow-paid')) {
    console.error(`REFUSING to run '${model}': bills per token. Re-run with --allow-paid if intended.`);
    process.exit(2);
  }
  const selected = (arg('--variant', 'v1')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const v of selected) if (!VARIANTS[v]) { console.error(`unknown variant '${v}' — have: ${Object.keys(VARIANTS).join(', ')}`); process.exit(2); }
  const onlyCase = arg('--case', null);

  // Load gold first. Running the model against unlabelled checklists would spend real
  // time to produce a scoreline with no meaning.
  const cases = [];
  const unlabelled = [];
  for (const { slug } of GOLD_CONTACTS) {
    if (onlyCase && slug !== onlyCase) continue;
    const lf = path.posix.join(LEDGER_DIR, `${slug}.txt`);
    const gf = path.posix.join(GOLD_DIR, `${slug}.md`);
    if (!fs.existsSync(lf) || !fs.existsSync(gf)) continue;
    const gold = parseGold(gf);
    if (!gold.all.size) continue;                 // nothing to label, not a case
    if (!gold.yes.size) { unlabelled.push(slug); continue; }
    cases.push({ slug, ledgerFile: lf, gold, today: todayFor(lf) });
  }

  if (unlabelled.length) {
    console.log(`skipping ${unlabelled.length} unlabelled: ${unlabelled.join(', ')}`);
    console.log('  (every candidate still unticked — label them or they score as all-negative)\n');
  }
  if (!cases.length) {
    console.error('NO LABELLED CASES. Run `node evals/tasks-fixtures.js` then tick the real');
    console.error(`commitments with [x] in ${GOLD_DIR}`);
    process.exit(2);
  }

  console.log(`model: ${model}${model.startsWith(FREE_PREFIX) ? '  (subscription — free)' : '  ** PAID **'}`);
  console.log(`${cases.length} labelled case(s) x ${selected.length} variant(s) = ${cases.length * selected.length} call(s)\n`);

  const results = [];
  for (const v of selected) {
    const promptFile = path.posix.join(ROOT, VARIANTS[v].prompt);
    if (!fs.existsSync(promptFile)) { console.log(`${v}: no prompt at ${promptFile} — skipped`); continue; }
    for (const c of cases) {
      process.stdout.write(`  ${v} ${c.slug} … `);
      let res;
      try {
        res = extractFor(c.slug, c.ledgerFile, c.today, { promptFile, model });
      } catch (e) {
        console.log(`FAILED (${String(e.message).slice(0, 90)})`);
        continue;
      }
      if (!res.ok) { console.log(`unparseable`); continue; }
      const s = score(res.tasks, c.gold);
      results.push({ variant: v, slug: c.slug, tasks: res.tasks, rejected: res.rejected, ...s, ledgerFile: c.ledgerFile });
      console.log(`${s.tp.length} hit, ${s.fp.length} false, ${s.fn.length} missed`);
    }
  }

  // ---- report ----
  console.log('\n================ PRECISION / RECALL ================\n');
  const pad = (s, n) => String(s).padEnd(n);
  for (const v of selected) {
    const rs = results.filter((r) => r.variant === v);
    if (!rs.length) continue;
    console.log(`${VARIANTS[v].label}`);
    console.log(`  ${pad('case', 22)}${pad('gold', 6)}${pad('emit', 6)}${pad('hit', 5)}${pad('false', 7)}${pad('miss', 6)}${pad('prec', 8)}recall`);
    for (const r of rs) {
      console.log(`  ${pad(r.slug, 22)}${pad(r.goldSize, 6)}${pad(r.emitted, 6)}${pad(r.tp.length, 5)}${pad(r.fp.length, 7)}${pad(r.fn.length, 6)}${pad(pct(r.precision), 8)}${pct(r.recall)}`);
    }
    const TP = rs.reduce((s, r) => s + r.tp.length, 0);
    const FP = rs.reduce((s, r) => s + r.fp.length, 0);
    const FN = rs.reduce((s, r) => s + r.fn.length, 0);
    const P = (TP + FP) ? TP / (TP + FP) : null;
    const R = (TP + FN) ? TP / (TP + FN) : null;
    const F = (P && R) ? (2 * P * R) / (P + R) : 0;
    console.log(`  ${pad('TOTAL', 22)}${pad(TP + FN, 6)}${pad(TP + FP, 6)}${pad(TP, 5)}${pad(FP, 7)}${pad(FN, 6)}${pad(pct(P), 8)}${pct(R)}   F1 ${pct(F)}`);

    // Does `confidence` carry information, or is it decoration? If both levels score
    // the same precision, the field is telling Nathan nothing and the UI should stop
    // showing it as though it were a signal.
    for (const level of ['explicit', 'probable']) {
      const at = rs.flatMap((r) => r.tasks
        .filter((t) => t.confidence === level)
        .map((t) => r.tp.includes(t.msgId)));
      if (!at.length) continue;
      const good = at.filter(Boolean).length;
      console.log(`  ${pad(`  confidence=${level}`, 22)}${pad('', 6)}${pad(at.length, 6)}${pad(good, 5)}${pad(at.length - good, 7)}${pad('', 6)}${pct(good / at.length)}`);
    }
    console.log('');
  }

  // Every false positive, with the line it cited — the actionable half of the report.
  const fps = results.flatMap((r) => r.fp.map((id) => ({ variant: r.variant, slug: r.slug, id, r })));
  if (fps.length) {
    console.log('================ FALSE POSITIVES ================\n');
    for (const f of fps) {
      const t = f.r.tasks.find((x) => x.msgId === f.id);
      console.log(`[${f.variant}] ${pad(f.slug, 18)} ${t ? t.title.slice(0, 60) : '?'}`);
      console.log(`     cites m${f.id}: ${ledgerLine(f.r.ledgerFile, f.id)}`);
    }
    console.log('');
  }

  const misses = results.flatMap((r) => r.fn.map((id) => ({ variant: r.variant, slug: r.slug, id, r })));
  if (misses.length) {
    console.log('================ MISSED (in gold, not extracted) ================\n');
    for (const m of misses) {
      console.log(`[${m.variant}] ${pad(m.slug, 18)} m${m.id}: ${ledgerLine(m.r.ledgerFile, m.id)}`);
    }
    console.log('');
  }

  const rej = results.flatMap((r) => r.rejected.map((x) => `[${r.variant}] ${r.slug}: ${x}`));
  if (rej.length) {
    console.log('================ REJECTED BY THE HARNESS ================\n');
    for (const x of rej) console.log(`  ${x}`);
  }
}

if (require.main === module) main();
module.exports = { score, VARIANTS };
