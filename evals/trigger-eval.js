'use strict';
// evals/trigger-eval.js — score the trigger prompt's three remaining jobs.
//
//   node evals/trigger-eval.js                          # dry run: show fixtures + gold
//   node evals/trigger-eval.js --model moonshotai/kimi-k2.6 --allow-paid
//   node evals/trigger-eval.js --model a,b --allow-paid  # compare two models
//
// WHAT THIS MEASURES, and what it deliberately does not. The regex decides whether
// something is a task, so recall is not in question and there is no precision/recall to
// compute. Everything left is the model's: does it resolve the object into a usable title,
// get the deadline right, and answer the two booleans that drive importance.
//
// DEADLINE and IMPORTANCE are scored EXACTLY — both are derived from things Nathan stated
// case by case, so they are facts, not opinions. TITLES are printed for him to eyeball,
// because "short but names its own object" is a judgement no assertion can make. Reporting
// a made-up title score would be worse than reporting none.
//
// THE FIXTURES ARE REAL CONTEXT WITH A SYNTHETIC TRIGGER. Nathan has never said "i'll make
// sure" in a task sense, so there is no natural corpus. Each fixture takes a real exchange
// where he did commit to something and rewrites ONLY his commitment line to use the trigger
// phrase — minimally, preserving whatever referential vagueness the original had, since
// resolving that vagueness is the thing being tested.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const { CRM_DB, ROOT } = require('../lib/config');
const TRIGGER = require('../lib/task-trigger');
const TASKS = require('../lib/tasks');
const { extractFor } = require('../scripts/crm-tasks');

const FREE_PREFIX = 'anthropic/';
const PROMPT = path.posix.join(ROOT, 'prompts', 'tasks-trigger.md');

// gold.deadline / gold.actionable / gold.importance come from Nathan's own answers, given
// case by case. gold.titleGist is what a good title has to convey — used for display and
// for a loose keyword check, never as a score.
const CASES = [
  {
    name: 'pine-pics', slug: 'pine-nguyen', id: 69215, before: 5, after: 5,
    rewrite: 'ill make sure to send those',
    gold: { deadline: '2026-05-26', actionable: true, importance: 3 },
    titleGist: ['pine', 'pic'], tests: 'object is "this week\'s pics", not the drive link; deadline from "out until tuesday"/"ill send it then" TWO LINES LATER, on a Saturday',
  },
  {
    name: 'charles-schedule', slug: 'charles-wu', id: 90973, before: 7, after: 3,
    rewrite: "ok ill make sure to get back to you on that by eod today",
    gold: { deadline: '2026-08-03', actionable: true, importance: 3 },
    titleGist: ['charles', 'schedule'], tests: 'compound ask over 4 messages; assent to a referential "that"; "by eod today" = the LINE\'s date (Pacific), not the run date',
  },
  {
    name: 'katia-move-check', slug: 'katia-jacoby', id: 90036, before: 6, after: 5,
    rewrite: 'ill make sure to check later',
    gold: { deadline: null, actionable: true, importance: 2 },
    titleGist: ['katia', 'move'], tests: 'THE HARD ONE — Aug 14/15 is when the EVENT is; the task is to check. Deadline must be null',
  },
  {
    name: 'ibuprofen', slug: 'katia-jacoby', id: 57989, before: 4, after: 2,
    rewrite: 'yeah ill make sure to grab it',
    gold: { deadline: null, actionable: true, importance: 2 },
    titleGist: ['ibuprofen'], tests: 'tiny errand, explicit object, no deadline anywhere — must not invent one',
  },
  {
    name: 'ken-donate', slug: 'ken-chessmore', id: 75417, before: 7, after: 4,
    rewrite: 'ye ill make sure to donate',
    gold: { deadline: null, actionable: false, importance: 1 },
    titleGist: ['ken', 'donat'], tests: 'BLOCKED — Ken has not created the donation yet ("imma do it tn"), so actionable is FALSE. The only importance-1 case',
  },
  {
    name: 'build-app', slug: 'runqi-gao', id: 3062, before: 7, after: 5,
    rewrite: 'ill make sure to build the app',
    gold: { deadline: null, actionable: true, importance: 2 },
    titleGist: ['app'], tests: 'large and open-ended, but nothing blocks it, so actionable is TRUE. Title must stay short despite 5 lines of spec following',
  },
  {
    name: 'fix-computer', slug: 'katia-jacoby', id: 89427, before: 4, after: 5,
    rewrite: 'ye ill make sure to',
    gold: { deadline: '2026-07-23', actionable: true, importance: 3 },
    titleGist: ['computer'], tests: 'deadline lives in the FOLLOW-UP line ("i\'ll do it when i get back tonight")',
  },
  {
    name: 'builders-two', slug: 'caden-chiang', id: 56270, before: 9, after: 3,
    rewrite: 'ill make sure to',
    gold: { deadline: null, actionable: true, importance: 2 },
    expectCount: 2,
    titleGist: ['builders'], tests: 'TWO tasks from one window (sign up + share); each title must name its own object with the sibling hidden',
  },
];

function fmtLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildFixture(db, c) {
  const all = db.prepare(
    "SELECT id, sent_at, sender, body FROM messages WHERE contact_slug = ? AND body IS NOT NULL AND TRIM(body) <> '' ORDER BY id",
  ).all(c.slug);
  const i = all.findIndex((m) => m.id === c.id);
  if (i === -1) return null;
  const lo = Math.max(0, i - c.before);
  const hi = Math.min(all.length - 1, i + c.after);
  const rows = all.slice(lo, hi + 1).map((m) => (m.id === c.id ? { ...m, body: c.rewrite } : m));
  const text = rows.map((m) => `[${fmtLocal(m.sent_at)}] ⟨m${m.id}⟩ ${m.sender}: ${m.body}`).join('\n');
  return { text, when: fmtLocal(all[i].sent_at) };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (['--allow-paid', '--show'].includes(a)) continue;
    if (['--model', '--case', '--before', '--after'].includes(a)) { i += 1; continue; }
    console.error(`unknown flag '${a}'\nknown: --model <m[,m]>, --case <name>, --before <n>, --after <n>, --allow-paid, --show`);
    process.exit(2);
  }
  const models = (arg('--model', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const onlyCase = arg('--case', null);
  // --before/--after override every case's context size. BOTH the fixture slice and the
  // window extractFor builds have to move together: widening only the fixture does nothing,
  // because findTriggers would trim it back to its own defaults (25/8) and the run would
  // look like "more context changed nothing" while the model saw exactly what it saw before.
  const beforeArg = arg('--before', null);
  const afterArg = arg('--after', null);
  const cases = CASES.filter((c) => !onlyCase || c.name === onlyCase).map((c) => ({
    ...c,
    before: beforeArg == null ? c.before : Number(beforeArg),
    after: afterArg == null ? c.after : Number(afterArg),
  }));

  const db = new DatabaseSync(CRM_DB, { readOnly: true });
  const built = [];
  for (const c of cases) {
    const f = buildFixture(db, c);
    if (!f) { console.log(`${c.name}: m${c.id} not found — skipped`); continue; }
    const t = TRIGGER.findTriggers(f.text);
    const fresh = t.windows.filter((w) => w.msgId === c.id);
    if (!fresh.length) { console.log(`${c.name}: REWRITE DOES NOT TRIGGER ("${c.rewrite}") — fix the fixture`); continue; }
    built.push({ ...c, ...f });
  }
  db.close();

  console.log(`${built.length}/${cases.length} fixtures build and trigger cleanly\n`);
  if (argv.includes('--show')) {
    for (const b of built) {
      console.log('='.repeat(76));
      console.log(`${b.name}  (${b.when})  expect: deadline=${b.gold.deadline || 'null'} actionable=${b.gold.actionable} imp=${b.gold.importance}${b.expectCount ? ` count=${b.expectCount}` : ''}`);
      console.log(`tests: ${b.tests}\n${b.text}\n`);
    }
  }
  if (!models.length) {
    console.log('no --model given. Add --model moonshotai/kimi-k2.6,moonshotai/kimi-k3 --allow-paid to score.');
    console.log('--show prints every fixture and its expected answer.');
    return;
  }

  const paid = models.filter((m) => !m.startsWith(FREE_PREFIX));
  if (paid.length && !argv.includes('--allow-paid')) {
    console.error(`REFUSING: ${paid.join(', ')} bill per token. Re-run with --allow-paid.`);
    process.exit(2);
  }

  const results = [];
  for (const model of models) {
    console.log(`\n${'#'.repeat(70)}\n# ${model}\n${'#'.repeat(70)}`);
    for (const b of built) {
      const tmp = path.join(os.tmpdir(), `trig-${process.pid}-${b.name}.txt`);
      fs.writeFileSync(tmp, b.text);
      let res;
      try {
        res = extractFor(b.slug, tmp, b.when.slice(0, 10), {
          promptFile: PROMPT, model, window: { before: b.before, after: b.after },
        });
      } catch (e) {
        console.log(`  ${b.name}: FAILED ${String(e.message).slice(0, 90)}`);
        results.push({ model, name: b.name, fail: true });
        continue;
      } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
      if (!res.ok) { console.log(`  ${b.name}: unparseable`); results.push({ model, name: b.name, fail: true }); continue; }

      const got = res.tasks;
      const wantN = b.expectCount || 1;
      const countOk = got.length === wantN;
      // Score against the FIRST element; a multi-task case is checked on count separately
      // because the fields should agree across siblings from one trigger.
      const t = got[0] || {};
      const imp = t.title ? TASKS.deriveImportance(t) : null;
      const dOk = (t.deadline || null) === b.gold.deadline;
      const aOk = (t.actionable === true) === b.gold.actionable;
      const iOk = imp === b.gold.importance;
      results.push({ model, name: b.name, dOk, aOk, iOk, countOk, got, gold: b.gold, wantN });

      console.log(`  ${b.name}`);
      console.log(`    deadline   ${dOk ? 'ok  ' : 'MISS'} got ${JSON.stringify(t.deadline || null)} want ${JSON.stringify(b.gold.deadline)}`);
      console.log(`    actionable ${aOk ? 'ok  ' : 'MISS'} got ${t.actionable} want ${b.gold.actionable}`);
      console.log(`    importance ${iOk ? 'ok  ' : 'MISS'} got ${imp} want ${b.gold.importance}`);
      if (b.expectCount) console.log(`    count      ${countOk ? 'ok  ' : 'MISS'} got ${got.length} want ${wantN}`);
      for (const g of got) console.log(`    title: "${g.title}"${g.description ? `\n      desc: ${g.description}` : ''}`);
      for (const r of res.rejected) console.log(`    ! ${r}`);
    }
  }

  console.log(`\n${'='.repeat(70)}\nSCORES (deadline / actionable / importance are exact; titles are for eyeballing)\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('model', 30)}${pad('deadline', 11)}${pad('actionable', 12)}${pad('importance', 12)}count`);
  for (const model of models) {
    const rs = results.filter((r) => r.model === model && !r.fail);
    const n = rs.length || 1;
    const f = (k) => `${rs.filter((r) => r[k]).length}/${rs.length}`;
    const withCount = rs.filter((r) => r.wantN > 1);
    console.log(`${pad(model, 30)}${pad(f('dOk'), 11)}${pad(f('aOk'), 12)}${pad(f('iOk'), 12)}${withCount.length ? `${withCount.filter((r) => r.countOk).length}/${withCount.length}` : '—'}`);
  }
}

if (require.main === module) main();
module.exports = { CASES };
