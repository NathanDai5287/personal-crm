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
// SANDBOXING: every (variant, case) gets its own throwaway tree containing only a
// copy of the profile and its ledger. The merge runs with cwd set there, so a
// prompt under test physically cannot damage a real profile, and "which files
// changed" becomes an exact, cheap signal rather than a guess.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mergeContact } = require('../scripts/crm-merge');
const { buildFixtures } = require('./cases');
const { runChecks } = require('./checks');
const { openCrmDb } = require('../lib/signal-db');

const SCRATCH = process.env.CRM_EVAL_DIR
  || 'C:/Users/natha/AppData/Local/Temp/claude/C--Users-natha--openclaw/7de048dc-42ba-4c94-b38c-b7fc743ad280/scratchpad/crm-eval';

const FREE_PREFIX = 'anthropic/';
const DEFAULT_MODEL = 'anthropic/claude-opus-5';

const VARIANTS = {
  a: {
    label: 'A (current)',
    prompt: 'prompts/merge.md',
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
};

function sha(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

// Hash every file in the sandbox so "what changed" is exact.
function snapshot(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else out.set(r, sha(fs.readFileSync(abs)));
    }
  };
  walk(dir, '');
  return out;
}

function makeSandbox(root, c) {
  const contacts = path.join(root, 'data', 'contacts');
  const refresh = path.join(contacts, '_refresh');
  fs.mkdirSync(refresh, { recursive: true });
  fs.writeFileSync(path.join(contacts, `${c.slug}.md`), c.profile);
  fs.writeFileSync(path.join(refresh, `${c.slug}.new.txt`), c.ledger);
  return path.join(contacts, `${c.slug}.md`);
}

// Resolve ⟨m…⟩ ids against the REAL archive (read-only).
function makeResolver() {
  let db;
  try { db = openCrmDb(); } catch { return null; }
  const stmt = db.prepare('SELECT 1 AS ok FROM messages WHERE id = ?');
  return (ids) => ids.filter((id) => !stmt.get(id));
}

function scoreOne(c, variantKey, runDir, resolveIds) {
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
    canary: c.canary,
    expectNoop: c.expectNoop,
  });
  return { ...meta, checks };
}

function runOne(c, variantKey, runDir, model, today) {
  const v = VARIANTS[variantKey];
  const dir = path.join(runDir, variantKey, c.name);
  const sandbox = path.join(dir, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });
  makeSandbox(sandbox, c);

  const filesBefore = snapshot(sandbox);
  const started = Date.now();
  const res = mergeContact(c.slug, {
    cwd: sandbox,
    promptFile: path.resolve(__dirname, '..', v.prompt),
    model,
    userMessage: v.user(c, today),
    quiet: true,
  });
  const elapsed = Date.now() - started;
  const filesAfter = snapshot(sandbox);

  const reply = String(res.output || res.error || '').trim();
  fs.writeFileSync(path.join(dir, 'reply.txt'), reply);
  const meta = {
    case: c.name, slug: c.slug, variant: variantKey, model, ok: res.ok, elapsed,
    reply: reply.slice(-400),
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
  const model = arg('--model', DEFAULT_MODEL);
  const onlyVariant = arg('--variant', null);
  const onlyCase = arg('--case', null);
  const scoreOnly = arg('--score-only', null);
  const today = arg('--today', new Date().toISOString().slice(0, 10));

  if (!model.startsWith(FREE_PREFIX) && !argv.includes('--allow-paid')) {
    console.error(`REFUSING to run '${model}': billed per token. Re-run with --allow-paid if that is intended.`);
    process.exit(2);
  }

  const runDir = scoreOnly || path.join(SCRATCH, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(runDir, { recursive: true });

  console.log('building fixtures…');
  let cases = buildFixtures(path.join(runDir, 'fixtures'));
  if (onlyCase) cases = cases.filter((c) => c.name === onlyCase);
  const variants = onlyVariant ? [onlyVariant] : Object.keys(VARIANTS);

  console.log(`\n${cases.length} case(s) x ${variants.length} variant(s) = ${cases.length * variants.length} run(s)`);
  console.log(`model: ${model}${model.startsWith(FREE_PREFIX) ? '  (subscription auth — no per-token cost)' : '  (PAID)'}`);
  console.log(`runDir: ${runDir}\n`);
  for (const c of cases) console.log(`  ${pad(c.name, 16)} ${pad(c.slug, 24)} ${pad(`${c.messages} msgs`, 12)} ${c.why}`);

  if (!scoreOnly) {
    console.log('');
    for (const c of cases) {
      for (const v of variants) {
        process.stdout.write(`run ${pad(`${v}/${c.name}`, 24)} … `);
        const m = runOne(c, v, runDir, model, today);
        console.log(`${m.ok ? 'ok' : 'FAILED'}  ${(m.elapsed / 1000).toFixed(0)}s`);
      }
    }
  }

  const resolveIds = makeResolver();
  const scored = [];
  for (const c of cases) {
    for (const v of variants) {
      try { scored.push(scoreOne(c, v, runDir, resolveIds)); } catch (e) {
        console.log(`score ${v}/${c.name}: ${e.message}`);
      }
    }
  }
  fs.writeFileSync(path.join(runDir, 'scored.json'), JSON.stringify(scored, null, 2));
  report(cases, scored);
  console.log(`\nartifacts: ${runDir}`);
}

if (require.main === module) main();
module.exports = { VARIANTS, runOne, scoreOne };
