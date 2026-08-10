'use strict';
// evals/run.js — A/B two merge prompts over a fixed fixture set and score the
// results deterministically.
//
//   node evals/run.js                        # both variants, Opus 5, free
//   node evals/run.js --variant b            # one variant
//   node evals/run.js --case injection       # one case
//   node evals/run.js --score-only <runDir>  # re-score cached outputs, no calls
//
// COST SAFETY: Anthropic models go through pi's Claude-subscription auth and cost
// nothing per token; moonshotai/* bills a real card. This script therefore
// REFUSES to run a paid model unless --allow-paid is passed explicitly, so no
// accidental flag or default can spend money.
//
// SANDBOXING: every (variant, case) gets its own throwaway tree — a COPY of the
// project, with fixture profiles standing in for data/contacts/ and synthesised
// stand-ins for the archive and the secrets. The merge runs with cwd set there, so a
// prompt under test physically cannot damage a real profile, and "which files
// changed" becomes an exact, cheap signal rather than a guess. It used to be a cwd
// with exactly two files in it, which is the tell this eval was measuring around;
// evals/sandbox.js documents what is copied, what is stood in for, and why.
// `--bare-sandbox` restores the old two-file tree as a control.

const fs = require('fs');
const path = require('path');
const { mergeContact } = require('../scripts/crm-merge');
const { buildFixtures } = require('./cases');
const { runChecks } = require('./checks');
const { extractThinking, formatTrace } = require('./thinking');
const { makeSandbox, snapshot, projectFiles, profileSet } = require('./sandbox');
const { openCrmDb } = require('../lib/signal-db');

const SCRATCH = process.env.CRM_EVAL_DIR
  || 'C:/Users/natha/AppData/Local/Temp/claude/C--Users-natha--openclaw/7de048dc-42ba-4c94-b38c-b7fc743ad280/scratchpad/crm-eval';

const FREE_PREFIX = 'anthropic/';
const DEFAULT_MODEL = 'anthropic/claude-opus-5';

// Variants point at VERSIONED prompt files, never at prompts/merge.md. merge.md
// is production and moves when a prompt is promoted; if variant A tracked it,
// promoting C would silently turn the control into the treatment and every past
// run would become unreproducible.
const VARIANTS = {
  a: {
    label: 'A (original)',
    prompt: 'prompts/merge-v1.md',
    // Verbatim production user turn — a faithful control.
    user: () => 'Merge the new messages into this profile per your instructions.',
  },
  b: {
    label: 'B (rewrite)',
    prompt: 'prompts/merge-v2.md',
    // The rewrite's position is that run-specific context belongs in the user
    // turn; withholding it was itself a high-severity finding. Supplying it is
    // part of variant B, not a thumb on the scale.
    user: (c, today) => [
      `Merge the new messages into ${c.slug}'s profile.`,
      '',
      `Profile file: data/contacts/${c.slug}.md`,
      `Ledger file:  data/contacts/_refresh/${c.slug}.new.txt`,
      `Ledger covers: ${c.chunkLabel} (${c.messages} messages)`,
      `Today's date: ${today}`,
    ].join('\n'),
  },
  // C = B plus the capture fixes from the Fable 5 critique. B beat A on
  // faithfulness and restraint but LOST selection and talking_points, because
  // the v2 rewrite silently dropped two of A's capture-driving instructions
  // (the talking-point category checklist, and the verb "add" for open
  // questions) and taught the model to treat Nathan's half of the conversation
  // as noise. Same user turn as B, so the prompt file is the only variable.
  c: {
    label: 'C (B + capture)',
    prompt: 'prompts/merge-v3.md',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // K = the SAME prompt as C on a different model. The only variable is the
  // model, so a C-vs-K comparison answers "does this prompt survive a weaker
  // instruction-follower" rather than confounding prompt and model together.
  // PAID: this variant bills per token, so --allow-paid is required to run it.
  k: {
    label: 'K3 (prompt C)',
    prompt: 'prompts/merge-v3.md',
    model: 'moonshotai/kimi-k3',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // D = the K3-tuned rewrite, on Opus. Must not regress Opus, since D replaces C.
  d: {
    label: 'D (K3-tuned)',
    prompt: 'prompts/merge-v4.md',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // REASONING SWEEP. Same prompt, same model, only the thinking level differs.
  // The first K3 run passed no --thinking at all and inherited pi's configured
  // default, so it ran at 'high' without that being a deliberate choice; these
  // make the level explicit and comparable. All PAID.
  kd_low: {
    label: 'K3+D think=low', prompt: 'prompts/merge-v4.md',
    model: 'moonshotai/kimi-k3', thinking: 'low',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  kd_high: {
    label: 'K3+D think=high', prompt: 'prompts/merge-v4.md',
    model: 'moonshotai/kimi-k3', thinking: 'high',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  kd_max: {
    label: 'K3+D think=max', prompt: 'prompts/merge-v4.md',
    model: 'moonshotai/kimi-k3', thinking: 'max',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // E = C plus four worked examples, chosen by Nathan from Fable-drafted
  // alternatives. Targets SELECTION specifically — the one dimension K3 lost
  // 3-0 to Opus under the judge, and the one thing prose instruction failed to
  // move (D was longer, more explicit, and scored identically to C).
  //
  // CONTAMINATION: the examples are built from arshia-nayebnazar and charles-wu
  // messages, which are also eval fixtures. Cases from those two slugs are
  // tagged heldOut:false and their scores are training-set scores. The held-out
  // subtotal is the number that means anything.
  e: {
    label: 'E (C + few-shot)',
    prompt: 'prompts/merge-v5.md',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // F = E plus provenance in `## What I know`. Nathan's call: it is the section he
  // reads most, so it is the least acceptable place to have none. Per-claim ids on
  // checkable facts only; characterisation prose stays uncited; legacy uncited
  // claims are left alone rather than given borrowed ids.
  f: {
    label: 'F (E + cited WIK)',
    prompt: 'prompts/merge-v6.md',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // G = the provenance-ranges prompt, promoted to production merge.md
  // 2026-08-04. F is the control (same lineage minus the range grammar). The
  // first F-vs-G run answers whether Opus emits the new grammar as reliably as
  // the old (spec §7: drift rates are separator-specific) and hands the arena
  // its first pair.
  g: {
    label: 'G (ranges)',
    prompt: 'prompts/merge-v7.md',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // H = G plus two prompt-only rules (Nathan, 2026-08-07): a citation's range
  // must be self-sufficient evidence for the claim it backs, and `## What I
  // know` is one topic per bullet — multi-topic bullets split when touched.
  // G is the control; run both on the same model so the prompt is the only
  // variable.
  h: {
    label: 'H (G + granular)',
    prompt: 'prompts/merge-v8.md',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // I = H plus the 2026-08-07 prompt-audit repairs: restores v4's "Write claims
  // at the strength they were said" section and the profile-is-notes-only hard
  // rule (minus v4's "strange message" clause, which v7 deliberately reversed —
  // the injection case expects record-as-data), and operationalizes the overlap
  // and separate-moments citation rules. H is the control.
  i: {
    label: 'I (H + audit)',
    prompt: 'prompts/merge-v9.md',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // J = I plus the What-I-know two-tier rule (Nathan's 2026-08-08 selections):
  // eight first-class topics (school/career, money, health, living situation,
  // dating, family, friend graph, dynamic-with-Nathan) recorded in detail;
  // everything else is texture — one short bullet per topic, refreshed in
  // place, never grown — with an anti-chill clause so the tier compresses
  // rather than drops. I is the control.
  j: {
    label: 'J (I + tiers)',
    prompt: 'prompts/merge-v10.md',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // L = J plus the 2026-08-09 What-I-know restructure (Nathan's redesign): ###
  // topic sections with plain uncited summary sentences, **Sub-topic:** threads,
  // the ` ts` time-sensitive flag riding in a claim's newest citation (with
  // lapsed claims anchored to their period), and Relationship/Birthday fillable
  // only from _TBD_. J is the control.
  l: {
    label: 'L (J + sections)',
    prompt: 'prompts/merge-v11.md',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // The same pair on the PRODUCTION model. The G→H→I→J lineage was promoted on
  // Opus evidence alone, so J has never been measured where it actually ships;
  // running incumbent and candidate together prices that in. Both PAID.
  kj_high: {
    label: 'K3+J think=high', prompt: 'prompts/merge-v10.md',
    model: 'moonshotai/kimi-k3', thinking: 'high',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  kl_high: {
    label: 'K3+L think=high', prompt: 'prompts/merge-v11.md',
    model: 'moonshotai/kimi-k3', thinking: 'high',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // K3 on F, to confirm the weaker model can carry the extra convention.
  kf_high: {
    label: 'K3+F think=high', prompt: 'prompts/merge-v6.md',
    model: 'moonshotai/kimi-k3', thinking: 'high',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  // The reasoning sweep Nathan asked for, on E rather than D — D was never
  // promoted and the few-shot prompt is the live candidate. Same prompt, same
  // model, thinking level is the only variable. Both PAID.
  ke_high: {
    label: 'K3+E think=high', prompt: 'prompts/merge-v5.md',
    model: 'moonshotai/kimi-k3', thinking: 'high',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
  ke_max: {
    label: 'K3+E think=max', prompt: 'prompts/merge-v5.md',
    model: 'moonshotai/kimi-k3', thinking: 'max',
    user: (c, today) => VARIANTS.b.user(c, today),
  },
};

// snapshot() and makeSandbox() live in evals/sandbox.js — the sandbox is now a whole
// project tree rather than two files, and the rules about what may and may not be
// copied into it are long enough to deserve their own file.

// Resolve ⟨m…⟩ ids against the REAL archive (read-only).
function makeResolver() {
  let db;
  try { db = openCrmDb(); } catch { return null; }
  const stmt = db.prepare('SELECT 1 AS ok FROM messages WHERE id = ?');
  return (ids) => ids.filter((id) => !stmt.get(id));
}

// Resolve a RANGE citation against the real archive, for citation_range_valid.
// `m<id>` is Signal's global rowid, so the range means the thread of its start —
// `conv_id = thread(start) AND id BETWEEN start AND end` (docs/PROVENANCE-SPEC.md
// §3). Without this the check falls back to the ledger, which can only judge
// citations whose endpoints are inside the chunk under test; the archive also sees
// the ones carried forward from earlier chunks.
function makeRangeResolver() {
  let db;
  try { db = openCrmDb(); } catch { return null; }
  const thread = db.prepare('SELECT conv_id FROM messages WHERE id = ?');
  const span = db.prepare('SELECT id FROM messages WHERE conv_id = ? AND id BETWEEN ? AND ? ORDER BY id');
  return (start, end) => {
    const s = thread.get(start);
    const e = thread.get(end);
    // A row archived before conv_id existed cannot be thread-filtered. Report it
    // as not found so the check SKIPS the citation rather than failing it on an
    // archive gap the merge had no part in.
    const startThread = s && s.conv_id != null ? s.conv_id : null;
    return {
      startFound: Boolean(s) && startThread !== null,
      endFound: Boolean(e) && e.conv_id != null,
      startThread,
      endThread: e && e.conv_id != null ? e.conv_id : null,
      ids: startThread === null ? [] : span.all(startThread, start, end).map((r) => r.id),
    };
  };
}

function scoreOne(c, variantKey, runDir, resolveIds, resolveRange) {
  const dir = path.join(runDir, variantKey, c.name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const profileRel = `data/contacts/${c.slug}.md`;
  const afterText = fs.readFileSync(path.join(dir, 'sandbox', profileRel), 'utf8');
  const checks = runChecks({
    beforeText: c.profile,
    afterText,
    ledger: c.ledger,
    profileRel,
    filesBefore: new Map(meta.filesBefore),
    filesAfter: new Map(meta.filesAfter),
    resolveIds,
    resolveRange,
    canary: c.canary,
    expectNoop: c.expectNoop,
  });
  return { ...meta, checks };
}

// A variant may pin its own model (see `k`); otherwise the run-wide --model wins.
function modelFor(variantKey, globalModel) {
  return VARIANTS[variantKey].model || globalModel;
}

// opts: { cases, bare } — `cases` is the whole fixture set, which makeSandbox uses
// as the decoy-profile pool so data/contacts/ is not a directory of one. Omitting it
// still works and yields a single-profile sandbox.
function runOne(c, variantKey, runDir, globalModel, today, opts = {}) {
  const v = VARIANTS[variantKey];
  const model = modelFor(variantKey, globalModel);
  const dir = path.join(runDir, variantKey, c.name);
  const sandbox = path.join(dir, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });
  makeSandbox(sandbox, c, { cases: opts.cases, bare: opts.bare });

  const filesBefore = snapshot(sandbox);
  const started = Date.now();
  // Sessions land OUTSIDE the sandbox: snapshot() hashes every file in the
  // sandbox to decide what the merge touched, and session files appearing
  // mid-run would register as writes the model never made.
  const sessionDir = path.join(dir, 'session');
  const res = mergeContact(c.slug, {
    cwd: sandbox,
    promptFile: path.resolve(__dirname, '..', v.prompt),
    model,
    thinking: v.thinking || null,
    userMessage: v.user(c, today),
    sessionDir,
    quiet: true,
  });
  const elapsed = Date.now() - started;
  const filesAfter = snapshot(sandbox);

  const reply = String(res.output || res.error || '').trim();
  fs.writeFileSync(path.join(dir, 'reply.txt'), reply);

  // Thinking is only in the session file, never on stdout.
  let think = { blocks: [], models: [], chars: 0 };
  try {
    think = extractThinking(sessionDir);
    fs.writeFileSync(
      path.join(dir, 'thinking.txt'),
      formatTrace({ case: c.name, variant: variantKey, model, thinking: v.thinking }, think),
    );
  } catch (e) {
    fs.writeFileSync(path.join(dir, 'thinking.txt'), `(extraction failed: ${e.message})`);
  }

  const meta = {
    case: c.name, slug: c.slug, variant: variantKey, model, thinking: v.thinking || null, ok: res.ok, elapsed,
    reply: reply.slice(-400),
    thinkingBlocks: think.blocks.length,
    thinkingChars: think.chars,
    thinkingReadable: think.blocks.some((b) => !b.encrypted),
    filesBefore: [...filesBefore], filesAfter: [...filesAfter],
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(meta, null, 2));
  return meta;
}

function pad(s, n) { return String(s).padEnd(n); }

function report(cases, scored) {
  const ids = [...new Set(scored.flatMap((s) => s.checks.results.map((r) => r.id)))];
  const variants = [...new Set(scored.map((s) => s.variant))].sort();

  console.log('\n================ CHECK MATRIX ================\n');
  const head = `${pad('check', 26)}${variants.map((v) => pad(`  ${VARIANTS[v].label}`, 16)).join('')}`;
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const id of ids) {
    const sev = scored.flatMap((s) => s.checks.results).find((r) => r.id === id).severity;
    const cells = variants.map((v) => {
      const rs = scored.filter((s) => s.variant === v).flatMap((s) => s.checks.results).filter((r) => r.id === id);
      const p = rs.filter((r) => r.pass).length;
      return pad(`  ${p}/${rs.length}${p === rs.length ? ' ok' : ' FAIL'}`, 16);
    });
    console.log(`${pad(`${id} [${sev[0]}]`, 26)}${cells.join('')}`);
  }

  console.log('\n================ PER-CASE SCORES ================\n');
  console.log(`${pad('case', 16)}${pad('messages', 10)}${variants.map((v) => pad(VARIANTS[v].label, 16)).join('')}`);
  for (const c of cases) {
    const cells = variants.map((v) => {
      const s = scored.find((x) => x.variant === v && x.case === c.name);
      if (!s) return pad('—', 16);
      return pad(`${s.checks.score}/${s.checks.maxScore}${s.ok ? '' : ' (ERR)'}`, 16);
    });
    console.log(`${pad(c.name, 16)}${pad(c.messages ?? '', 10)}${cells.join('')}`);
  }
  console.log('');
  for (const v of variants) {
    const ss = scored.filter((s) => s.variant === v);
    const got = ss.reduce((a, s) => a + s.checks.score, 0);
    const max = ss.reduce((a, s) => a + s.checks.maxScore, 0);
    const secs = Math.round(ss.reduce((a, s) => a + s.elapsed, 0) / 1000);
    console.log(`${pad(VARIANTS[v].label, 16)} ${got}/${max}  (${(100 * got / max).toFixed(1)}%)   ${secs}s total`);
  }

  console.log('\n================ FAILURES ================\n');
  let any = false;
  for (const s of scored) {
    for (const f of s.checks.failed) {
      any = true;
      console.log(`[${f.severity.toUpperCase().padEnd(6)}] ${pad(VARIANTS[s.variant].label, 14)} ${pad(s.case, 15)} ${pad(f.id, 24)} ${f.detail}`);
    }
  }
  if (!any) console.log('(none)');
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

  // REJECT UNKNOWN FLAGS. `arg()` looks for an exact match and returns the default
  // otherwise, so a near-miss like `--variants e,f` (the flag is singular) was silently
  // ignored and the run proceeded on DEFAULT_VARIANTS — twelve merges of the wrong
  // prompts, reported as a clean result. An eval that quietly measures something other
  // than what was asked for is worse than one that crashes.
  const VALUE_FLAGS = ['--model', '--variant', '--case', '--score-only', '--today', '--fixtures-from'];
  const BOOL_FLAGS = ['--allow-paid', '--bare-sandbox'];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (BOOL_FLAGS.includes(a)) continue;
    if (VALUE_FLAGS.includes(a)) { i += 1; continue; }
    console.error(`unknown flag '${a}'`);
    console.error(`known: ${[...VALUE_FLAGS.map((f) => `${f} <value>`), ...BOOL_FLAGS].join(', ')}`);
    process.exit(2);
  }

  const model = arg('--model', DEFAULT_MODEL);
  const onlyVariant = arg('--variant', null);
  const onlyCase = arg('--case', null);
  const scoreOnly = arg('--score-only', null);
  const today = arg('--today', new Date().toISOString().slice(0, 10));
  // The pre-2026-08-04 two-file sandbox, kept as the control for "did the realistic
  // tree move the score". Not a default: a bare cwd is the tell this eval was
  // measuring around (evals/sandbox.js).
  const bare = argv.includes('--bare-sandbox');

  // Default to the FREE Opus variants only. The paid and reasoning-sweep
  // variants must be asked for by name, so a bare `node evals/run.js` can never
  // start spending.
  const DEFAULT_VARIANTS = ['a', 'b', 'c', 'd'];
  const selected = onlyVariant ? onlyVariant.split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_VARIANTS;
  for (const v of selected) if (!VARIANTS[v]) { console.error(`unknown variant '${v}' — have: ${Object.keys(VARIANTS).join(', ')}`); process.exit(2); }
  const paid = [...new Set(selected.map((v) => modelFor(v, model)))].filter((m) => !m.startsWith(FREE_PREFIX));
  if (paid.length && !argv.includes('--allow-paid')) {
    console.error(`REFUSING to run: ${paid.join(', ')} bill per token.`);
    console.error(`Selected variants: ${selected.map((v) => `${v}=${modelFor(v, model)}`).join(', ')}`);
    console.error('Re-run with --allow-paid if that is intended.');
    process.exit(2);
  }

  const runDir = scoreOnly || path.join(SCRATCH, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(runDir, { recursive: true });

  console.log('building fixtures…');
  const fixturesDir = path.join(runDir, 'fixtures');
  let cases;
  const from = arg('--fixtures-from', null);
  if (from) {
    // Comparing two MODELS means the inputs must be byte-identical, not merely
    // rebuilt by the same deterministic code. Copy the earlier run's fixtures.
    const src = path.join(fs.existsSync(from) ? from : path.join(SCRATCH, from), 'fixtures', 'cases.json');
    cases = JSON.parse(fs.readFileSync(src, 'utf8'));
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.writeFileSync(path.join(fixturesDir, 'cases.json'), JSON.stringify(cases, null, 2));
    console.log(`  reusing ${cases.length} fixture(s) from ${src}`);
  } else if (scoreOnly && fs.existsSync(path.join(fixturesDir, 'cases.json'))) {
    // Re-score against the ORIGINAL fixtures. Rebuilding them would silently
    // re-derive from a since-changed archive and score old outputs against new
    // inputs — the classic way a re-scored eval quietly stops meaning anything.
    cases = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'cases.json'), 'utf8'));
  } else {
    cases = buildFixtures(fixturesDir);
    fs.writeFileSync(path.join(fixturesDir, 'cases.json'), JSON.stringify(cases, null, 2));
  }
  // The decoy-profile pool is the WHOLE fixture set, captured before --case filters
  // it. Otherwise `--case injection` would build a sandbox with one profile in
  // data/contacts/ and quietly stop being comparable to the same case inside a full
  // run — the sandbox a case sees must not depend on what else was selected.
  const allCases = cases;
  if (onlyCase) cases = cases.filter((c) => c.name === onlyCase);
  const variants = selected;

  console.log(`\n${cases.length} case(s) x ${variants.length} variant(s) = ${cases.length * variants.length} run(s)`);
  for (const v of variants) {
    const m = modelFor(v, model);
    console.log(`  ${VARIANTS[v].label.padEnd(18)} ${VARIANTS[v].prompt.padEnd(22)} ${m}${m.startsWith(FREE_PREFIX) ? '  (subscription — free)' : '  ** PAID **'}`);
  }
  console.log(`runDir: ${runDir}`);
  // Only on a real run: --score-only builds no sandbox, and printing what one would
  // have contained would describe a tree this invocation never made.
  if (!scoreOnly) {
    console.log(bare
      ? 'sandbox: BARE — profile + ledger only (the pre-2026-08-04 tree)\n'
      : `sandbox: project copy — ${projectFiles().length} project file(s), `
        + `${profileSet(allCases, null).size} profile(s) in data/contacts/, 1 ledger\n`);
  }
  for (const c of cases) console.log(`  ${pad(c.name, 16)} ${pad(c.slug, 24)} ${pad(`${c.messages} msgs`, 12)} ${c.why}`);

  if (!scoreOnly) {
    console.log('');
    for (const c of cases) {
      for (const v of variants) {
        process.stdout.write(`run ${pad(`${v}/${c.name}`, 24)} … `);
        const m = runOne(c, v, runDir, model, today, { cases: allCases, bare });
        const th = m.thinkingBlocks
          ? `  think ${m.thinkingBlocks}blk/${(m.thinkingChars / 1000).toFixed(1)}k${m.thinkingReadable ? '' : ' (enc)'}`
          : '';
        console.log(`${m.ok ? 'ok' : 'FAILED'}  ${(m.elapsed / 1000).toFixed(0)}s${th}`);
      }
    }
  }

  const resolveIds = makeResolver();
  const resolveRange = makeRangeResolver();
  const scored = [];
  for (const c of cases) {
    for (const v of variants) {
      try { scored.push(scoreOne(c, v, runDir, resolveIds, resolveRange)); } catch (e) {
        console.log(`score ${v}/${c.name}: ${e.message}`);
      }
    }
  }
  fs.writeFileSync(path.join(runDir, 'scored.json'), JSON.stringify(scored, null, 2));
  report(cases, scored);

  // HELD-OUT SUBTOTAL. Variant E embeds examples built from arshia-nayebnazar
  // and charles-wu messages, so its score on those cases is a training-set
  // score and will flatter it. Only the held-out pool measures generalisation.
  const heldOut = new Set(cases.filter((c) => c.heldOut).map((c) => c.name));
  const contaminated = cases.filter((c) => !c.heldOut).map((c) => c.name);
  if (heldOut.size && contaminated.length) {
    console.log('\n================ HELD-OUT vs CONTAMINATED ================\n');
    console.log(`held-out cases:     ${[...heldOut].join(', ')}`);
    console.log(`example-source cases: ${contaminated.join(', ')}  <- E has seen these\n`);
    console.log(`${pad('variant', 20)}${pad('held-out', 16)}${pad('example-source', 16)}`);
    for (const v of variants) {
      const rows = scored.filter((s) => s.variant === v);
      const sub = (pred) => {
        const rs = rows.filter((s) => pred(s.case));
        const got = rs.reduce((a, s) => a + s.checks.score, 0);
        const max = rs.reduce((a, s) => a + s.checks.maxScore, 0);
        return max ? `${got}/${max} (${(100 * got / max).toFixed(1)}%)` : '—';
      };
      console.log(`${pad(VARIANTS[v].label, 20)}${pad(sub((n) => heldOut.has(n)), 16)}${pad(sub((n) => !heldOut.has(n)), 16)}`);
    }
  }

  console.log(`\nartifacts: ${runDir}`);
}

if (require.main === module) main();
module.exports = { VARIANTS, runOne, scoreOne };
