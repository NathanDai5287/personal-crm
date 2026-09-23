'use strict';
// evals/model-compare.js — the same REAL merge chunks, run through two (or more) MODELS on
// the production prompt, scored side by side. A model comparison, not a prompt A/B
// (that is evals/run.js). Inputs come straight from the memory history: for a chunk's
// merge commit C, the prompt input is C~1's profile and C's committed ledger — exactly
// what production fed that merge — and C's own profile is kept as a third reference
// ("what production actually wrote").
//
//   CRM_PI_CLI=<pi cli.js> node evals/model-compare.js --out <dir> \
//     --models anthropic/claude-opus-5-5,deepseek/deepseek-flash \
//     --chunks ken-chessmore:40a71a6,katia-jacoby:d2978cb [--judge anthropic/claude-fable-5-1] --allow-paid
//
// SAFETY: each merge runs in an evals/sandbox.js copy of the project (never the real
// data/); the real crm.db is only READ (citation resolution). Refuses any non-anthropic
// model without --allow-paid, like evals/run.js. The output dir holds private message
// content — keep it out of the repo and delete it when done.
//
// Scoring per (chunk, model): evals/checks.js deterministic checks; the [[FACTS]] block
// (present, parses, every source id in the ledger or carried from the profile); cost and
// wall time from pi's session. Then a BLIND pairwise judge (evals/judge.js's rubric,
// order-swapped, a win counts only when both orders agree) between the first two models.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mergeContact } = require('../scripts/crm-merge');
const { runChecks } = require('./checks');
const { makeSandbox, snapshot } = require('./sandbox');
const J = require('./judge');
const { openCrmDb } = require('../lib/signal-db');
const { parseStructuredReply, profileCitationIds } = require('../lib/structured-person');
const { ROOT, GITDIR, MERGE_PROMPT, PI_CLI } = require('../lib/config');

const argv = process.argv.slice(2);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };
const OUT = arg('--out');
const MODELS = String(arg('--models', '')).split(',').filter(Boolean);
const CHUNKS = String(arg('--chunks', '')).split(',').filter(Boolean).map((s) => { const [slug, sha] = s.split(':'); return { slug, sha }; });
const JUDGE = arg('--judge', 'anthropic/claude-fable-5-1');
const ALLOW_PAID = argv.includes('--allow-paid');
if (!OUT || MODELS.length < 2 || !CHUNKS.length) {
  console.error('usage: model-compare --out <dir> --models a,b --chunks slug:sha,... [--judge m] [--allow-paid]');
  process.exit(2);
}
for (const m of [...MODELS, JUDGE]) {
  if (!m.startsWith('anthropic/') && !ALLOW_PAID) { console.error(`refusing paid model ${m} without --allow-paid`); process.exit(2); }
}

const git = (...a) => execFileSync('git', [`--git-dir=${GITDIR}`, ...a], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function loadCase({ slug, sha }) {
  const subject = git('log', '-1', '--format=%s', sha).trim();
  const model = git('log', '-1', '--format=%(trailers:key=Model,valueonly,separator=)', sha).trim();
  return {
    name: `${slug}@${sha}`, slug, sha, subject, prodModel: model,
    profile: git('show', `${sha}~1:data/contacts/${slug}.md`),
    ledger: git('show', `${sha}:data/contacts/_refresh/${slug}.new.txt`),
    prodAfter: git('show', `${sha}:data/contacts/${slug}.md`),
  };
}

function makeResolvers() {
  const db = openCrmDb();
  const one = db.prepare('SELECT 1 FROM messages WHERE id = ?');
  const thread = db.prepare('SELECT conv_id FROM messages WHERE id = ?');
  const span = db.prepare('SELECT id FROM messages WHERE conv_id = ? AND id BETWEEN ? AND ? ORDER BY id');
  return {
    resolveIds: (ids) => ids.filter((id) => !one.get(id)),
    resolveRange: (start, end) => {
      const s = thread.get(start); const e = thread.get(end);
      const st = s && s.conv_id != null ? s.conv_id : null;
      return { startFound: Boolean(s) && st !== null, endFound: Boolean(e) && e.conv_id != null, startThread: st, endThread: e && e.conv_id != null ? e.conv_id : null, ids: st === null ? [] : span.all(st, start, end).map((r) => r.id) };
    },
  };
}

function factsReport(reply, ledger, before) {
  const ledgerIds = new Set([...ledger.matchAll(/⟨m(\d+)⟩/g)].map((m) => Number(m[1])));
  const carried = new Set(profileCitationIds(before));
  try {
    const p = parseStructuredReply(reply, { required: true });
    const bad = p.facts.filter((f) => !(ledgerIds.has(Number(f && f.source_message_id)) || carried.has(Number(f && f.source_message_id))));
    return { present: true, count: p.facts.length, badSource: bad.length, fields: p.facts.map((f) => f && f.field).filter(Boolean) };
  } catch (e) {
    return { present: false, error: e.message.slice(0, 200) };
  }
}

function runMerge(c, model, dir, res) {
  const sandbox = path.join(dir, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });
  makeSandbox(sandbox, c, {});
  const filesBefore = snapshot(sandbox);
  const t0 = Date.now();
  const r = mergeContact(c.slug, { cwd: sandbox, promptFile: MERGE_PROMPT, model, sessionDir: path.join(dir, 'session'), quiet: true, maxAttempts: 2 });
  const ms = Date.now() - t0;
  const filesAfter = snapshot(sandbox);
  const profileRel = `data/contacts/${c.slug}.md`;
  const after = fs.readFileSync(path.join(sandbox, profileRel), 'utf8');
  const reply = String(r.reply || r.output || r.error || '');
  fs.writeFileSync(path.join(dir, 'after.md'), after);
  fs.writeFileSync(path.join(dir, 'reply.txt'), reply);
  const checks = runChecks({ beforeText: c.profile, afterText: after, ledger: c.ledger, profileRel, filesBefore, filesAfter, resolveIds: res.resolveIds, resolveRange: res.resolveRange });
  const out = {
    model, ok: r.ok, error: r.ok ? null : String(r.error || '').slice(0, 400), ms, costUsd: r.costUsd ?? null, attempts: r.attempts,
    ack: (reply.match(/(^|\n)\s*(DONE[^\n]*|NO-?OP)/i) || [])[2] || null,
    score: checks.score, maxScore: checks.maxScore,
    failed: checks.failed.map((f) => ({ id: f.id, severity: f.severity, detail: String(f.detail || f.message || '').slice(0, 300) })),
    facts: factsReport(reply, c.ledger, c.profile),
    afterChars: after.length,
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(out, null, 2));
  return { ...out, after };
}

function judgeSystem() {
  // Same rubric as evals/judge.js; only the framing says models, not prompts.
  return J.SYSTEM.replace('produced by different prompts', 'produced by different models').replace('which prompt produced which', 'which model produced which');
}
function callJudge(user, file) {
  fs.writeFileSync(file, user);
  const out = execFileSync(process.execPath, [PI_CLI, '-p', '--no-session', '-nc', '--no-extensions', '--no-skills', '--no-tools',
    '--model', JUDGE, '--system-prompt', judgeSystem(), `@${file}`, 'Judge the two candidates in the attached file. Reply with the JSON object only.'],
  { encoding: 'utf8', timeout: 900_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' } });
  fs.writeFileSync(`${file}.reply.txt`, out);
  return J.extractJson(String(out));
}

function judgePair(c, A, B, dir) {
  const [a, b] = [A.model, B.model];
  const tryTwice = (fn) => { try { return fn(); } catch { return fn(); } };
  const fwd = tryTwice(() => callJudge(J.buildUser(c, A.after, B.after), path.join(dir, 'judge-fwd.txt')));
  const rev = tryTwice(() => callJudge(J.buildUser(c, B.after, A.after), path.join(dir, 'judge-rev.txt')));
  const map1 = (w, first, second) => (w === '1' ? first : w === '2' ? second : 'tie');
  const dims = {};
  for (const [k] of J.DIMENSIONS) {
    const f = map1(fwd.dimensions?.[k]?.winner, a, b);
    const r = map1(rev.dimensions?.[k]?.winner, b, a);
    dims[k] = { winner: J.reconcile(f, r), fwd: f, rev: r, why: [fwd.dimensions?.[k]?.why, rev.dimensions?.[k]?.why] };
  }
  const of = map1(fwd.overall?.winner, a, b);
  const or = map1(rev.overall?.winner, b, a);
  const unsupported = [
    ...(fwd.unsupported_claims || []).map((u) => ({ model: map1(String(u.candidate), a, b), claim: u.claim })),
    ...(rev.unsupported_claims || []).map((u) => ({ model: map1(String(u.candidate), b, a), claim: u.claim })),
  ];
  return { dims, overall: { winner: J.reconcile(of, or), fwd: of, rev: or, why: [fwd.overall?.why, rev.overall?.why] }, unsupported };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const res = makeResolvers();
  const summary = { startedAt: new Date().toISOString(), models: MODELS, judge: JUDGE, prompt: path.relative(ROOT, MERGE_PROMPT), piCli: PI_CLI, cases: [] };
  for (const spec of CHUNKS) {
    const c = loadCase(spec);
    const cdir = path.join(OUT, c.name.replace(/[@:]/g, '_'));
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'before.md'), c.profile);
    fs.writeFileSync(path.join(cdir, 'ledger.txt'), c.ledger);
    fs.writeFileSync(path.join(cdir, 'prod-after.md'), c.prodAfter);
    console.log(`\n== ${c.name}: ${c.subject} (production: ${c.prodModel})`);
    const runs = [];
    for (const m of MODELS) {
      process.stdout.write(`   ${m} ... `);
      const r = runMerge(c, m, path.join(cdir, m.replace(/\//g, '_')), res);
      console.log(`${r.ok ? 'ok' : 'FAIL'} ${Math.round(r.ms / 1000)}s $${r.costUsd == null ? '?' : r.costUsd.toFixed(4)} checks ${r.score}/${r.maxScore} facts ${r.facts.present ? r.facts.count : 'MISSING'}`);
      runs.push(r);
    }
    let judge = null;
    if (runs[0].ok && runs[1].ok) {
      process.stdout.write(`   judge ${JUDGE} ... `);
      try { judge = judgePair(c, runs[0], runs[1], cdir); console.log(`overall: ${judge.overall.winner}`); } catch (e) { judge = { error: e.message }; console.log(`FAILED ${e.message.slice(0, 120)}`); }
    }
    summary.cases.push({ name: c.name, slug: c.slug, sha: c.sha, subject: c.subject, prodModel: c.prodModel, ledgerLines: c.ledger.split('\n').filter((l) => l.startsWith('[')).length, runs: runs.map(({ after, ...r }) => r), judge });
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  }
  summary.endedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nwrote ${path.join(OUT, 'summary.json')}`);
}

main();
