'use strict';
// crm-todo-scan.js — the frequent, nearly-free half of todo capture.
//
//   node scripts/crm-todo-scan.js                 # dry run: scan, report, no writes
//   node scripts/crm-todo-scan.js --write         # extract + insert, advance cursor
//   node scripts/crm-todo-scan.js --since 90000   # rescan from an id, ignore the cursor
//
// WHY IT IS SEPARATE FROM crm-daily.js. Nathan: "dont want todo generation to run on a
// schedule. the non_ai part should run frequently, maybe once every 30 min or 1 hr just to
// detect any messages that say 'make sure'."
//
// So this reads crm.db DIRECTLY rather than the ledgers crm-refresh writes. Ledgers only
// exist after a daily run and their windows move; the archive is append-only and already
// refreshed hourly by crm-archive.js ("no AI, no profile edits, seconds of work"), which
// makes it the right thing to poll. Freshness is therefore bounded by the archive sweep,
// not by this script — bump the "Personal CRM Archive Sweep" task if an hour is too slow.
//
// THE SCAN IS FREE. Reading messages and running a regex costs nothing, so this can run as
// often as you like. A model is invoked ONLY when the regex fires, which on Nathan's real
// history is about 0.2 times a month.
//
// PAID BY DEFAULT, AND GUARDED. Nathan: "i will not be using opus for anything in the app.
// it will all be kimi models." moonshotai/* bills per token, so a run that would spend
// refuses unless told to: --allow-paid, or CRM_ALLOW_PAID=1 in the scheduled task's
// environment. At ~3,100 tokens per trigger this is pennies a year, but an unguarded
// scheduled task that can spend money is a bad shape regardless of the amount.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { CRM_DB, DATA_DIR, TRACKED, ROOT } = require('../lib/config');
const TRIGGER = require('../lib/task-trigger');
const TASKS = require('../lib/tasks');
const { extractFor } = require('./crm-tasks');

const STATE = path.posix.join(DATA_DIR, 'crm-todo-state.json');
const MODEL = process.env.CRM_TODO_MODEL || 'moonshotai/kimi-k2.6';
const PROMPT = process.env.CRM_TODO_PROMPT || path.posix.join(ROOT, 'prompts', 'tasks-trigger.md');
const FREE_PREFIX = 'anthropic/';

// Context reaches back before the cursor, so a trigger whose antecedent predates the last
// scan still resolves. Only the TRIGGER has to be new; its context does not.
const CONTEXT_LOOKBACK = 60;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { cursors: {} }; }
}
function saveState(s) {
  const tmp = `${STATE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE);
}

function fmtLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Same shape crm-refresh writes, because lib/task-trigger.js parses that format and the
// model's prompt documents it. Timestamps are LOCAL, i.e. Pacific, matching every other
// ledger in the system.
function renderLedger(rows) {
  return rows.map((m) => `[${fmtLocal(m.sent_at)}] ⟨m${m.id}⟩ ${m.sender}: ${m.body}`).join('\n');
}

function contactsToScan(db) {
  let slugs = [];
  try { slugs = JSON.parse(fs.readFileSync(TRACKED, 'utf8')).slugs || []; } catch { /* fall back */ }
  if (slugs.length) return slugs;
  return db.prepare('SELECT DISTINCT contact_slug s FROM messages WHERE contact_slug IS NOT NULL').all().map((r) => r.s);
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (['--write', '--allow-paid', '--verbose'].includes(a)) continue;
    if (['--since', '--slug', '--model'].includes(a)) { i += 1; continue; }
    console.error(`unknown flag '${a}'\nknown: --write, --allow-paid, --verbose, --since <id>, --slug <slug>, --model <m>`);
    process.exit(2);
  }
  const write = argv.includes('--write');
  const model = arg('--model', MODEL);
  const sinceOverride = arg('--since', null);
  const onlySlug = arg('--slug', null);

  const state = loadState();
  // Captured BEFORE the scan loop, which populates state.cursors as it goes. Computing it
  // afterwards made the notice below unreachable under --write — i.e. it only ever appeared
  // on dry runs, and never on the one run where "history was deliberately skipped" is the
  // thing you need to be told.
  const firstRun = !Object.keys(state.cursors || {}).length;
  const db = new DatabaseSync(CRM_DB, { readOnly: true });
  const slugs = (onlySlug ? [onlySlug] : contactsToScan(db)).filter(Boolean);

  // PASS 1 — free. Find every new trigger before deciding whether any model call is
  // needed at all, so the paid-model guard only fires when there is real work.
  const found = [];
  let scanned = 0;
  const nearMisses = [];
  for (const slug of slugs) {
    const cursor = sinceOverride != null ? Number(sinceOverride) : (state.cursors[slug] || 0);
    const maxRow = db.prepare('SELECT MAX(id) hi FROM messages WHERE contact_slug = ?').get(slug);
    if (!maxRow || !maxRow.hi || maxRow.hi <= cursor) continue;
    const rows = db.prepare(
      `SELECT id, sent_at, sender, body FROM messages
       WHERE contact_slug = ? AND id > ? AND body IS NOT NULL AND TRIM(body) <> '' ORDER BY id`,
    ).all(slug, Math.max(0, cursor - CONTEXT_LOOKBACK));
    if (!rows.length) continue;
    scanned += rows.filter((r) => r.id > cursor).length;

    const ledger = renderLedger(rows);
    const res = TRIGGER.findTriggers(ledger);
    if (!state.cursors[slug] && sinceOverride == null) {
      // No cursor for this contact yet: adopt the current head rather than treating all of
      // history as new. --since is the deliberate way to reach backwards.
      if (write) state.cursors[slug] = maxRow.hi;
      continue;
    }
    // A trigger at or below the cursor was already handled on an earlier run; it is only
    // present here to provide context.
    const fresh = res.windows.filter((w) => w.msgId > cursor);
    // Every near-miss past the cursor, unbounded. The first-run branch above returns
    // before this, so the cursor is what keeps the list short — no age or count cap needed,
    // and capping would hide the case this exists to catch.
    for (const nm of res.nearMisses) {
      if (nm.id <= cursor) continue;
      const row = rows.find((r) => r.id === nm.id);
      nearMisses.push({ slug, ...nm, at: row ? row.sent_at : 0 });
    }
    if (fresh.length) found.push({ slug, ledger, windows: fresh, hi: maxRow.hi });
    else if (write) state.cursors[slug] = maxRow.hi;   // nothing to do; move on
  }

  console.log(`scanned ${scanned} new message(s) across ${slugs.length} contact(s)`);
  if (firstRun && sinceOverride == null) {
    console.log('FIRST RUN: recording current position only. Past triggers are deliberately');
    console.log('not backfilled — Nathan: "it is not important that every past task is picked up".');
  }
  nearMisses.sort((a, b) => b.at - a.at);
  for (const nm of nearMisses) {
    console.log(`  ~ said "make sure" but not tracked — ${nm.slug}: "${String(nm.body).slice(0, 66)}"`);
  }
  if (!found.length) {
    console.log('no "i\'ll make sure" triggers — no model call, nothing to do');
    if (write) saveState(state);
    return;
  }

  const total = found.reduce((n, f) => n + f.windows.length, 0);
  console.log(`\n${total} trigger(s) in ${found.length} conversation(s):`);
  for (const f of found) {
    for (const w of f.windows) console.log(`  ${f.slug} ⟨m${w.msgId}⟩ ${w.weekday} ${w.when} — "${w.body.slice(0, 70)}"`);
  }

  const paid = !model.startsWith(FREE_PREFIX);
  if (paid && !argv.includes('--allow-paid') && process.env.CRM_ALLOW_PAID !== '1') {
    console.error(`\nREFUSING to call '${model}': bills per token. Pass --allow-paid, or set`);
    console.error('CRM_ALLOW_PAID=1 in the scheduled task environment.');
    process.exit(2);
  }
  if (!write) {
    console.log('\ndry run — re-run with --write to extract and insert');
    return;
  }

  // PASS 2 — the only part that costs anything.
  console.log(`\nmodel: ${model}${paid ? '  ** PAID **' : '  (subscription — free)'}`);
  const cdb = require('../lib/signal-db').openCrmDb();
  let inserted = 0;
  try {
    for (const f of found) {
      // extractFor reads a ledger from a path, so the scanned window is staged to a temp
      // file rather than duplicating its render/validate logic here.
      const tmp = path.posix.join(require('os').tmpdir(), `crm-todo-${process.pid}-${f.slug}.txt`);
      fs.writeFileSync(tmp, f.ledger);
      let res;
      try {
        res = extractFor(f.slug, tmp, fmtLocal(Date.now()).slice(0, 10), { promptFile: PROMPT, model });
      } catch (e) {
        console.log(`${f.slug}: FAILED (${String(e.message).slice(0, 120)}) — cursor NOT advanced`);
        continue;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* gone */ }
      }
      if (!res.ok) { console.log(`${f.slug}: ${res.error} — cursor NOT advanced`); continue; }

      for (const r of res.rejected) console.log(`   ! ${f.slug}: ${r}`);
      for (const t of res.tasks) {
        const imp = TASKS.deriveImportance(t);
        // DRAFT, not active. I had reasoned that since Nathan now decides WHETHER something
        // is a task, accepting it again is a pointless click — he overruled that: "i still
        // want the draft queue. i should manually accept each one." The title, deadline and
        // both booleans are still the model's guesses, and reviewing them at the moment
        // they appear is cheaper than discovering a wrong one later.
        const out = TASKS.insertDraft(cdb, t);
        if (out === 'inserted') {
          inserted += 1;
          console.log(`   + draft [${imp}] ${t.title}${t.deadline ? `  (due ${t.deadline})` : ''}${t.actionable ? '' : '  [blocked]'}`);
        } else {
          console.log(`   = already had: ${t.title}`);
        }
      }
      // Only advance past a conversation whose extraction actually succeeded, so a failure
      // is retried rather than silently skipped.
      state.cursors[f.slug] = f.hi;
    }
  } finally {
    if (cdb) try { cdb.close(); } catch { /* closed */ }
  }
  saveState(state);
  console.log(`\ninserted ${inserted} task(s)`);
}

if (require.main === module) main();
module.exports = { renderLedger };
