'use strict';
// evals/judge.js — the semantic half of the eval.
//
//   node evals/judge.js [runId|latest]
//
// The deterministic checks in checks.js score MECHANISM: right file, intact
// Timeline, real citations, canonical order. They are silent on the thing the
// merge actually exists to do — decide what is worth remembering about a person.
// That needs a reader, so a second model reads both outputs and says which one
// understood the conversation better.
//
// THREE THINGS MAKE THIS MORE THAN VIBES:
//
//  1. BLIND. The judge is shown "Output 1" and "Output 2" and is never told
//     which prompt produced either, so it cannot prefer the one described in
//     more impressive terms.
//  2. ORDER-SWAPPED. LLM judges have a well-known position bias. Every pair is
//     judged twice with the order reversed. A win only counts when it survives
//     both orders; when the two disagree, that IS the finding — the outputs are
//     indistinguishable on that dimension and we record a tie rather than
//     laundering a coin flip into a score.
//  3. DIFFERENT MODEL ROLE. The judge never generated any of this, and is
//     prompted to look for unsupported claims first, which is the failure the
//     deterministic checks structurally cannot see: a fabricated statement with
//     no citation attached has no citation to invalidate.
//
// Cost: Anthropic through pi's subscription auth, so free. Refuses paid models
// unless --allow-paid, same guard as run.js.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PI_CLI } = require('../lib/config');

const SCRATCH = process.env.CRM_EVAL_DIR
  || 'C:/Users/natha/AppData/Local/Temp/claude/C--Users-natha--openclaw/7de048dc-42ba-4c94-b38c-b7fc743ad280/scratchpad/crm-eval';
const MODEL = process.env.CRM_JUDGE_MODEL || 'anthropic/claude-opus-5';

const DIMENSIONS = [
  ['faithfulness', 'Is every claim actually supported by the ledger? Unsupported or embellished claims are the worst defect here.'],
  ['selection', 'Did it record what a thoughtful friend would want to remember, and leave out the noise?'],
  ['talking_points', 'Are the talking points specific and actionable, or vague and generic?'],
  ['integration', 'Did it merge into existing knowledge and resolve contradictions, or bolt on near-duplicates?'],
  ['restraint', 'Did it avoid padding, over-writing, and manufacturing content to look productive?'],
];

const SYSTEM = `You are evaluating two candidate updates to the same personal-CRM profile. Both were produced by different prompts from the SAME prior profile and the SAME ledger of new messages. You do not know which prompt produced which, and it does not matter.

Judge only the content and judgment on display. Ignore which is longer — more text is not better. Ignore formatting differences unless they affect usefulness.

Weigh these, in this order:

${DIMENSIONS.map(([k, d], i) => `${i + 1}. ${k} — ${d}`).join('\n')}

FAITHFULNESS IS THE HEAVIEST. A profile that states something the messages do not support is worse than one that records less. Check specific claims against the ledger. If a candidate asserts a fact you cannot locate in the ledger or in the prior profile, list it under unsupported_claims with the candidate number.

An empty or near-empty update is CORRECT when the ledger genuinely contains nothing worth recording. Do not reward a candidate for producing more content in that situation.

Reply with ONLY a JSON object, no prose around it, no markdown fence:

{
  "dimensions": {
${DIMENSIONS.map(([k]) => `    "${k}": {"winner": "1" | "2" | "tie", "why": "<one sentence>"}`).join(',\n')}
  },
  "overall": {"winner": "1" | "2" | "tie", "why": "<one or two sentences>"},
  "unsupported_claims": [{"candidate": "1" | "2", "claim": "<quote it>"}]
}`;

// The Timeline is untouched by the merge and dominates the byte count, so
// stripping it keeps the judge looking at what actually changed.
function withoutTimeline(md) {
  const lines = String(md).split('\n');
  const out = [];
  let skipping = false;
  for (const l of lines) {
    if (/^##\s+/.test(l)) skipping = /^##\s+Timeline\b/.test(l);
    if (skipping) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildUser(c, first, second) {
  return [
    `## The ledger of new messages`, '', '```', c.ledger.trim(), '```', '',
    // The prior profile is shown IN FULL, Timeline included. Stripping it to
    // save tokens was a real bug: the Timeline is prior evidence, so a claim
    // grounded there looked fabricated to the judge, and it duly flagged a
    // lodging arrangement recorded in an earlier Timeline entry as unsupported.
    // A faithfulness judge that cannot see half the evidence is worse than none.
    `## The profile BEFORE the update (complete, including Timeline)`, '', '```', c.profile.trim(), '```', '',
    // Candidates keep their Timeline stripped: it is byte-identical to the one
    // above (both are forbidden to touch it, and a deterministic check enforces
    // that), so including it twice more would only add noise.
    `## Candidate output 1 (Timeline omitted — unchanged from above)`, '', '```', withoutTimeline(first), '```', '',
    `## Candidate output 2 (Timeline omitted — unchanged from above)`, '', '```', withoutTimeline(second), '```', '',
    'A claim counts as supported if the ledger OR the prior profile (including its Timeline) supports it.',
    'Which candidate is the better update? Reply with the JSON object only.',
  ].join('\n');
}

// The materials go to a FILE and are inlined with pi's `@path`, never passed as
// argv. Windows caps a command line near 32KB and a 238-message ledger blows
// straight through it (ENAMETOOLONG) — which is also why crm-merge.js passes its
// ledger the same way.
function callJudge(system, user, scratchFile) {
  fs.writeFileSync(scratchFile, user);
  const out = execFileSync(process.execPath, [
    PI_CLI, '-p', '--no-session', '-nc', '--no-extensions', '--no-skills',
    '--no-tools', '--model', MODEL, '--system-prompt', system,
    `@${scratchFile}`,
    'Judge the two candidates in the attached file. Reply with the JSON object only.',
  ], { encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' } });
  const text = String(out).trim();
  fs.writeFileSync(`${scratchFile}.reply.txt`, text); // keep every raw reply for diagnosis
  return { parsed: extractJson(text), raw: text };
}

// Find the first COMPLETE brace-balanced object. A greedy /\{[\s\S]*\}/ grabs
// from the first `{` to the last `}` anywhere in the reply, which silently
// swallows trailing commentary and produces a confusing parse error deep inside
// otherwise-valid JSON. Scanning with string/escape awareness returns the object
// and stops, so trailing prose is simply ignored.
function extractJson(text) {
  const s = text.replace(/```(?:json)?/g, '');
  const start = s.indexOf('{');
  if (start === -1) throw new Error(`no JSON object in reply: ${s.slice(0, 200)}`);
  // Stack of open containers, so an unterminated reply can be closed in the
  // right order rather than by guessing.
  const stack = [];
  let inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }

  // BOUNDED REPAIR. Observed in the wild: the judge emitted 1,368 chars that
  // ended in `}]}` but never closed its `dimensions` object, and the retry made
  // the identical mistake — so retrying is not a fix for a systematic slip.
  // Appending the missing closers is only safe because the result is then
  // PARSED and SHAPE-CHECKED; a repair that yields the wrong shape is rejected
  // exactly like a parse failure, so this can salvage a truncated reply but can
  // never invent a verdict.
  if (!inStr && stack.length) {
    const repaired = s.slice(start) + stack.slice().reverse().join('');
    try {
      const obj = normalizeShape(JSON.parse(repaired));
      if (obj && obj.dimensions && obj.overall) return obj;
    } catch { /* fall through to the error below */ }
  }
  throw new Error(`unterminated JSON object (${stack.length} unclosed) in reply of ${s.length} chars`);
}

// Closing the containers at the END of the text is correct bracket-wise but puts
// every key that followed the unclosed one INSIDE it: the observed reply forgot
// to close `dimensions`, so `overall` and `unsupported_claims` became members of
// `dimensions`. Lifting them back out is the exact inverse of that specific
// mistake, not a guess — and the caller still validates the result, so a reply
// that was wrong in some other way is rejected rather than silently reshaped.
function normalizeShape(obj) {
  if (!obj || typeof obj !== 'object' || !obj.dimensions) return obj;
  for (const k of ['overall', 'unsupported_claims']) {
    if (obj[k] === undefined && obj.dimensions[k] !== undefined) {
      obj[k] = obj.dimensions[k];
      delete obj.dimensions[k];
    }
  }
  return obj;
}

function afterText(dir, variant, caseName, slug) {
  return fs.readFileSync(path.join(dir, variant, caseName, 'sandbox', 'data', 'contacts', `${slug}.md`), 'utf8');
}

// Map a judge's "1"/"2" verdict back to a variant, given which variant was shown
// first in that pass.
function toVariant(w, firstVariant, secondVariant) {
  if (w === '1') return firstVariant;
  if (w === '2') return secondVariant;
  return 'tie';
}

// A dimension is only decided when BOTH orders agree. Disagreement means the
// judge flipped with position, which is evidence of a tie, not of a winner.
function reconcile(fwd, rev) {
  return fwd === rev ? fwd : 'tie';
}

// A judge that returns malformed JSON once usually returns valid JSON on a
// second try; failing twice is a real signal worth surfacing rather than hiding.
function withRetry(fn) {
  try { return fn(); } catch {
    process.stdout.write('(retry) ');
    return fn();
  }
}

function main() {
  const argv = process.argv.slice(2);
  let id = argv.find((a) => !a.startsWith('--'));
  if (!MODEL.startsWith('anthropic/') && !argv.includes('--allow-paid')) {
    console.error(`REFUSING to judge with '${MODEL}': billed per token. Pass --allow-paid if intended.`);
    process.exit(2);
  }
  const pairIdx = argv.indexOf('--pair');
  const [V1, V2] = (pairIdx === -1 ? 'a,b' : argv[pairIdx + 1]).split(',').map((x) => x.trim());
  const runs = fs.readdirSync(SCRATCH).filter((d) => d.startsWith('run-')).sort();
  if (!id || id === 'latest') id = runs[runs.length - 1];
  const dir = path.join(SCRATCH, id);
  const scored = JSON.parse(fs.readFileSync(path.join(dir, 'scored.json'), 'utf8'));
  const cases = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures', 'cases.json'), 'utf8'));

  const caseNames = [...new Set(scored.map((s) => s.case))];
  console.log(`judging ${id} — ${V1.toUpperCase()} vs ${V2.toUpperCase()} — with ${MODEL} (subscription auth — free)`);
  console.log(`${caseNames.length} case(s) x 2 orders = ${caseNames.length * 2} call(s)\n`);

  const results = [];
  const failures = [];
  for (const cn of caseNames) {
    const c = cases.find((x) => x.name === cn);
    const run = scored.find((s) => s.case === cn);
    if (!c || !run) { console.log(`  skip ${cn}`); continue; }
    let a, b;
    try { a = afterText(dir, V1, cn, run.slug); b = afterText(dir, V2, cn, run.slug); } catch (e) {
      console.log(`  skip ${cn}: ${e.message}`); continue;
    }

    const jdir = path.join(dir, 'judge');
    fs.mkdirSync(jdir, { recursive: true });
    // One malformed reply must not destroy the cases already judged — the first
    // version of this lost three completed cases to a parse error on the fourth.
    let fwd, rev;
    try {
      process.stdout.write(`  ${cn.padEnd(16)} forward … `);
      fwd = withRetry(() => callJudge(SYSTEM, buildUser(c, a, b), path.join(jdir, `${cn}.${V1}${V2}.fwd.md`))).parsed; // 1=a, 2=b
      process.stdout.write('reverse … ');
      rev = withRetry(() => callJudge(SYSTEM, buildUser(c, b, a), path.join(jdir, `${cn}.${V1}${V2}.rev.md`))).parsed; // 1=b, 2=a
    } catch (e) {
      console.log(`UNJUDGED (${e.message.slice(0, 70)})`);
      failures.push({ case: cn, error: e.message });
      continue;
    }

    const dims = {};
    for (const [k] of DIMENSIONS) {
      const f = toVariant(fwd.dimensions?.[k]?.winner, V1, V2);
      const r = toVariant(rev.dimensions?.[k]?.winner, V2, V1);
      dims[k] = {
        winner: reconcile(f, r), forward: f, reverse: r,
        agreed: f === r,
        why: fwd.dimensions?.[k]?.why || '',
        whyReverse: rev.dimensions?.[k]?.why || '',
      };
    }
    const of = toVariant(fwd.overall?.winner, V1, V2);
    const or_ = toVariant(rev.overall?.winner, V2, V1);
    const overall = {
      winner: reconcile(of, or_), forward: of, reverse: or_, agreed: of === or_,
      why: fwd.overall?.why || '', whyReverse: rev.overall?.why || '',
    };
    const unsupported = [
      ...(fwd.unsupported_claims || []).map((u) => ({ variant: toVariant(u.candidate, V1, V2), claim: u.claim, pass: 'forward' })),
      ...(rev.unsupported_claims || []).map((u) => ({ variant: toVariant(u.candidate, V2, V1), claim: u.claim, pass: 'reverse' })),
    ].filter((u) => u.variant !== 'tie');

    results.push({ case: cn, dimensions: dims, overall, unsupported });
    console.log(`${overall.winner === 'tie' ? 'tie' : overall.winner.toUpperCase()}${overall.agreed ? '' : ' (order-flipped)'}`);
  }

  // A judgment over zero cases is not a tie, it is a broken invocation — but the
  // report below renders it as a tidy `A: 0  B: 0  tie: 0` with "No unsupported claims
  // flagged", which reads exactly like a clean result. That happened: the default pair
  // is a,b, so judging a run containing only e and f skipped all eight cases and
  // reported nothing wrong. Fail loudly instead.
  if (!results.length) {
    console.error(`\nJUDGED NOTHING: 0 of ${caseNames.length} case(s) produced a comparison for pair ${V1},${V2}.`);
    if (failures.length) for (const f of failures.slice(0, 3)) console.error(`  ${f.case || ''}: ${String(f.error || f).slice(0, 160)}`);
    const present = fs.readdirSync(dir).filter((d) => /^[a-z_]+$/.test(d) && fs.existsSync(path.join(dir, d)));
    console.error(`variants present in this run: ${present.join(', ') || '(none)'}`);
    console.error(`pass --pair <v1>,<v2> to pick a pair that exists (default is a,b).`);
    process.exit(2);
  }

  const payload = { model: MODEL, judgedAt: new Date().toISOString(), dimensions: DIMENSIONS.map(([k]) => k), pair: [V1, V2], results, failures };
  const outName = (V1 === 'a' && V2 === 'b') ? 'judge.json' : `judge-${V1}${V2}.json`;
  fs.writeFileSync(path.join(dir, outName), JSON.stringify(payload, null, 2));

  // ---- report ----
  console.log('\n================ SEMANTIC JUDGMENT ================\n');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('case', 16)}${DIMENSIONS.map(([k]) => pad(k.slice(0, 13), 15)).join('')}${pad('OVERALL', 10)}`);
  console.log('-'.repeat(16 + 15 * DIMENSIONS.length + 10));
  for (const r of results) {
    const cells = DIMENSIONS.map(([k]) => {
      const d = r.dimensions[k];
      return pad(d.winner === 'tie' ? (d.agreed ? 'tie' : 'tie*') : d.winner.toUpperCase(), 15);
    }).join('');
    console.log(`${pad(r.case, 16)}${cells}${pad(r.overall.winner === 'tie' ? 'tie' : r.overall.winner.toUpperCase(), 10)}`);
  }
  console.log('\n* = judge flipped with presentation order, recorded as a tie\n');

  const tally = { [V1]: 0, [V2]: 0, tie: 0 };
  for (const r of results) for (const [k] of DIMENSIONS) tally[r.dimensions[k].winner]++;
  console.log(`dimension wins   ${V1.toUpperCase()}: ${tally[V1]}   ${V2.toUpperCase()}: ${tally[V2]}   tie: ${tally.tie}   (of ${results.length * DIMENSIONS.length})`);
  const ov = { [V1]: 0, [V2]: 0, tie: 0 };
  for (const r of results) ov[r.overall.winner]++;
  console.log(`overall wins     ${V1.toUpperCase()}: ${ov[V1]}   ${V2.toUpperCase()}: ${ov[V2]}   tie: ${ov.tie}   (of ${results.length})`);

  const unsup = results.flatMap((r) => r.unsupported.map((u) => ({ ...u, case: r.case })));
  if (unsup.length) {
    console.log('\nUNSUPPORTED CLAIMS FLAGGED:');
    for (const u of unsup) console.log(`  [${u.variant.toUpperCase()}] ${pad(u.case, 15)} ${String(u.claim).slice(0, 90)}`);
  } else console.log('\nNo unsupported claims flagged.');

  if (failures.length) {
    console.log(`\n${failures.length} case(s) UNJUDGED — raw replies kept in judge/ for diagnosis:`);
    for (const f of failures) console.log(`  ${f.case}: ${f.error.slice(0, 140)}`);
  }
  console.log(`\nwrote ${path.join(dir, outName)}`);
}

if (require.main === module) main();
module.exports = { withoutTimeline, reconcile, extractJson };
