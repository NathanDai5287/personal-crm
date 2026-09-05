'use strict';
// crm-todo-scan.js — the frequent, nearly-free half of todo capture.
//
//   node scripts/crm-todo-scan.js                 # apply (default): extract + insert, advance cursor
//   node scripts/crm-todo-scan.js --dry-run       # preview: scan + report only, no writes, no model
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
const { renderedBody, formatLine } = require('../lib/message-context');

const STATE = path.posix.join(DATA_DIR, 'crm-todo-state.json');
const MODEL = process.env.CRM_TODO_MODEL || 'moonshotai/kimi-k3';
const PROMPT = process.env.CRM_TODO_PROMPT || path.posix.join(ROOT, 'prompts', 'tasks-trigger.md');
const FREE_PREFIX = 'anthropic/';

// Context reaches back before the cursor, so a trigger whose antecedent predates the last
// scan still resolves. Only the TRIGGER has to be new; its context does not.
const CONTEXT_LOOKBACK = 60;

// How many runs to retry a trigger the model SILENTLY DROPPED (findTriggers flagged it,
// extraction returned no task for it) before giving up. Retrying recovers a transient
// truncation/refusal (this is a plan model — retries are free), while the cap stops a
// deterministically-dropped trigger from blocking that contact's cursor forever.
const DROP_MAX_RETRIES = 3;

// SETTLE MARGIN. A trigger is not extracted until it is at least this old, so the AFTER
// window (lib/task-trigger.js) has time to fill with an immediate discharge ("nvm") before
// the once-only extraction runs. Without it, a "make sure" swept and scanned in the same
// hourly pass is extracted before its next lines exist, and the discharge — which lands
// after — is never reconsidered (the trigger sits below the cursor forever). See the
// 2026-08-22 entry in docs/ENGINEERING-LOG.md. 0 disables (today's behaviour); default 5m.
const SETTLE_MS = Math.max(0, Number(process.env.CRM_TODO_SETTLE_MIN || 5)) * 60_000;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { cursors: {} }; }
}
function saveState(s) {
  const tmp = `${STATE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE);
}

// Same shape crm-refresh writes (lib/task-trigger.js parses it and the model's prompt
// documents it). RENDERED (Layer 2: body + OCR/STT fold via lib/message-context), and
// UNCENSORED — this ledger is NEVER handed to a model directly. It feeds findTriggers
// (a local regex on typed words) and crm-tasks.extractFor, which re-renders the trigger
// windows through redact (task-trigger.renderWindows) before the model sees anything, so
// egress censoring already happens downstream. Censoring HERE would be both pointless and
// harmful: redact's replacement contains a `]` ("[redacted black slur]"), which closes
// ownWords' fold-strip `[^\]]*` early and lets a "make sure"/"eod" SPOKEN in a transcript
// leak past the typed-only guard and mint a task. Keeping it uncensored is what lets the
// fold-strip see clean markers. Timestamps are Pacific (Intl, not the host clock).
function renderLedger(cdb, rows) {
  return rows.map((m) => formatLine({ sentAt: m.sent_at, rid: m.id, sender: m.sender, body: renderedBody(cdb, m) })).join('\n');
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
    if (['--write', '--dry-run', '--allow-paid', '--verbose', '--force'].includes(a)) continue;
    if (['--since', '--slug', '--model'].includes(a)) { i += 1; continue; }
    console.error(`unknown flag '${a}'\nknown: --dry-run, --allow-paid, --verbose, --force, --since <id>, --slug <slug>, --model <m>`);
    process.exit(2);
  }
  // STANDARD CONTRACT (see lib/run-toggles.paused): real by default, --dry-run previews.
  // `--write` is the old spelling of "apply"; it is now the default, so it is accepted as a
  // silent no-op. `write` is derived as !DRY_RUN so the apply/skip body below is unchanged.
  const DRY_RUN = argv.includes('--dry-run');
  const write = !DRY_RUN;
  const force = argv.includes('--force');
  // --model flag > web-UI 'todo' dropdown > CRM_TODO_MODEL env / default.
  const model = arg('--model', require('../lib/run-models').getModel('todo') || MODEL);
  const sinceOverride = arg('--since', null);
  const onlySlug = arg('--slug', null);
  const startedAt = Date.now();

  const state = loadState();
  // Captured BEFORE the scan loop, which populates state.cursors as it goes. Computing it
  // afterwards made the notice below unreachable under --write — i.e. it only ever appeared
  // on dry runs, and never on the one run where "history was deliberately skipped" is the
  // thing you need to be told.
  const firstRun = !Object.keys(state.cursors || {}).length;
  const db = new DatabaseSync(CRM_DB, { readOnly: true });
  // crm.db is WAL now, so a pure reader like this scan never sees SQLITE_BUSY from a
  // writer at all. busy_timeout is kept as belt-and-suspenders (covers the pre-WAL
  // failure mode if the file were ever restored un-WAL'd, and costs nothing).
  db.exec('PRAGMA busy_timeout = 15000');
  const slugs = (onlySlug ? [onlySlug] : contactsToScan(db)).filter(Boolean);

  // PASS 1 — free. Find every new trigger before deciding whether any model call is
  // needed at all, so the paid-model guard only fires when there is real work.
  const found = [];
  let scanned = 0;
  let heldTotal = 0;
  const nearMisses = [];
  for (const slug of slugs) {
    const cursor = sinceOverride != null ? Number(sinceOverride) : (state.cursors[slug] || 0);
    const maxRow = db.prepare('SELECT MAX(id) hi FROM messages WHERE contact_slug = ?').get(slug);
    if (!maxRow || !maxRow.hi || maxRow.hi <= cursor) continue;
    const rows = db.prepare(
      `SELECT id, sent_at, sender, body, att_hashes FROM messages
       WHERE contact_slug = ? AND id > ? AND body IS NOT NULL AND TRIM(body) <> '' ORDER BY id`,
    ).all(slug, Math.max(0, cursor - CONTEXT_LOOKBACK));
    if (!rows.length) continue;
    scanned += rows.filter((r) => r.id > cursor).length;

    const ledger = renderLedger(db, rows);
    const res = TRIGGER.findTriggers(ledger);
    if (!state.cursors[slug] && sinceOverride == null) {
      // No cursor for this contact yet: adopt the current head rather than treating all of
      // history as new. --since is the deliberate way to reach backwards.
      if (write) state.cursors[slug] = maxRow.hi;
      continue;
    }
    // A trigger at or below the cursor was already handled on an earlier run; it is only
    // present here to provide context.
    const candidates = res.windows.filter((w) => w.msgId > cursor);
    // SETTLE GUARD. Hold back any candidate whose trigger was sent within SETTLE_MS: it is
    // too fresh for its AFTER window to have filled. `safeHi` is the highest id we may
    // advance the cursor to without stepping past a held trigger — everything below the
    // earliest held one is settled and may be extracted now; the held one is left above the
    // cursor so it is reconsidered (older) next run. sent_at is absolute epoch ms, so this
    // comparison is timezone-independent (the Pacific formatting is display-only).
    const NOW = Date.now();
    const sentAtOf = (id) => { const r = rows.find((x) => x.id === id); return r ? r.sent_at : 0; };
    const heldIds = candidates.filter((w) => sentAtOf(w.msgId) > NOW - SETTLE_MS).map((w) => w.msgId);
    const safeHi = heldIds.length ? Math.min(maxRow.hi, Math.min(...heldIds) - 1) : maxRow.hi;
    heldTotal += heldIds.length;
    // Ripe = settled AND below the earliest held trigger. extractFor re-scans whatever
    // ledger it is handed, so the extraction ledger is CAPPED at safeHi — that is the only
    // way to keep a held trigger out of the model call, not merely off this list.
    const ripe = candidates.filter((w) => w.msgId <= safeHi);
    // Every near-miss past the cursor, unbounded. The first-run branch above returns
    // before this, so the cursor is what keeps the list short — no age or count cap needed,
    // and capping would hide the case this exists to catch.
    for (const nm of res.nearMisses) {
      if (nm.id <= cursor) continue;
      const row = rows.find((r) => r.id === nm.id);
      nearMisses.push({ slug, ...nm, at: row ? row.sent_at : 0 });
    }
    if (ripe.length) {
      const capped = safeHi >= maxRow.hi ? ledger : renderLedger(db, rows.filter((r) => r.id <= safeHi));
      found.push({ slug, ledger: capped, windows: ripe, hi: safeHi });
    } else if (write) {
      state.cursors[slug] = safeHi;   // nothing ripe; advance only past settled ground
    }
  }

  console.log(`scanned ${scanned} new message(s) across ${slugs.length} contact(s)`);
  if (heldTotal) {
    console.log(`  … ${heldTotal} trigger(s) too fresh (<${SETTLE_MS / 60_000}m old) — holding for a later run so the discharge window can fill`);
  }
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
    if (write) { saveState(state); recordTodoRun(startedAt, scanned, slugs.length, 0, 0); }
    return;
  }

  const total = found.reduce((n, f) => n + f.windows.length, 0);
  console.log(`\n${total} trigger(s) in ${found.length} conversation(s):`);
  for (const f of found) {
    for (const w of f.windows) console.log(`  ${f.slug} ⟨m${w.msgId}⟩ ${w.weekday} ${w.when} — "${w.body.slice(0, 70)}"`);
  }

  // RUN-TOGGLE PAUSE. When the web UI has paused todo capture, a real run reports
  // the triggers it found but makes NO model call and does NOT advance the cursors
  // of the `found` conversations — so they are re-extracted once it is switched
  // back on. A hand-started UI run passes --force and skips this. Dry runs (free)
  // fall through to the plan below.
  if (require('../lib/run-toggles').paused('todo', { dryRun: DRY_RUN, force })) {
    console.log(`\ntodo: PAUSED via the web UI toggle — ${total} trigger(s) held, no model call (enable it in the UI, or pass --force).`);
    saveState(state);
    recordTodoRun(startedAt, scanned, slugs.length, total, 0, model, []);
    return;
  }

  const paid = !model.startsWith(FREE_PREFIX);
  if (paid && !argv.includes('--allow-paid') && process.env.CRM_ALLOW_PAID !== '1') {
    console.error(`\nREFUSING to call '${model}': bills per token. Pass --allow-paid, or set`);
    console.error('CRM_ALLOW_PAID=1 in the scheduled task environment.');
    process.exit(2);
  }
  if (DRY_RUN) {
    console.log('\ndry run — re-run without --dry-run to extract and insert');
    return;
  }

  // PASS 2 — the only part that costs anything.
  console.log(`\nmodel: ${model}${paid ? '  ** PAID **' : '  (on plan — no metered cost)'}`);
  const cdb = require('../lib/signal-db').openCrmDb();
  let inserted = 0;
  // The tasks actually inserted this run, so the run's detail page can show them
  // as an additions-only diff (a todo run has no profile to diff, but this is the
  // equivalent record of what it produced).
  const captured = [];
  // Triggers the model dropped DROP_MAX_RETRIES runs in a row and we've now stopped
  // retrying — reported at the end so a persistently-lost commitment stays visible.
  const givenUpDrops = [];
  // ACTUAL billed cost, summed across the model calls this run made — tracked on the
  // run record, but NEVER fed to the cost estimator (no recordCostSample here) and
  // computed independently of the fitted model. null until a paid call is captured.
  let actualUsd = null;
  try {
    for (const f of found) {
      // extractFor reads a ledger from a path, so the scanned window is staged to a temp
      // file rather than duplicating its render/validate logic here.
      const tmp = path.posix.join(require('os').tmpdir(), `crm-todo-${process.pid}-${f.slug}.txt`);
      fs.writeFileSync(tmp, f.ledger);
      let res;
      try {
        res = extractFor(f.slug, tmp, { promptFile: PROMPT, model, captureCost: true });
      } catch (e) {
        console.log(`${f.slug}: FAILED (${String(e.message).slice(0, 120)}) — cursor NOT advanced`);
        continue;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* gone */ }
      }
      if (!res.ok) { console.log(`${f.slug}: ${res.error} — cursor NOT advanced`); continue; }
      if (res.costUsd != null) actualUsd = (actualUsd || 0) + res.costUsd;

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
          captured.push({ slug: f.slug, title: t.title, deadline: t.deadline || null, importance: imp, actionable: t.actionable !== false });
          console.log(`   + draft [${imp}] ${t.title}${t.deadline ? `  (due ${t.deadline})` : ''}${t.actionable ? '' : '  [blocked]'}`);
        } else {
          console.log(`   = already had: ${t.title}`);
        }
      }
      // DROPPED-TRIGGER GUARD (F5). findTriggers flagged these ("make sure"/"eod") but the
      // model returned no task for them — advancing the cursor past a dropped trigger loses
      // an explicit commitment forever. Retry each up to DROP_MAX_RETRIES runs (recovers a
      // transient truncation/refusal for free), holding the cursor just below the earliest
      // still-retriable dropped trigger so it — and everything after — is reconsidered next
      // run. A trigger dropped that many runs in a row is given up on (cursor allowed past)
      // but reported LOUDLY, so it is surfaced rather than silently lost or permanently
      // blocking the contact.
      state.droppedRetries = state.droppedRetries || {};
      const dr = state.droppedRetries[f.slug] || {};
      const droppedNow = (res.dropped || []).map((d) => d.msgId).filter((id) => id > cursor);
      const droppedSet = new Set(droppedNow);
      for (const k of Object.keys(dr)) { if (!droppedSet.has(Number(k))) delete dr[k]; } // recovered / below cursor
      let blockingId = null;
      for (const id of droppedNow) {
        dr[id] = (dr[id] || 0) + 1;
        if (dr[id] < DROP_MAX_RETRIES) blockingId = blockingId == null ? id : Math.min(blockingId, id);
        else {
          console.log(`   !! ${f.slug}: giving up on dropped trigger ⟨m${id}⟩ after ${dr[id]} tries — NOT captured`);
          givenUpDrops.push({ slug: f.slug, msgId: id });
          delete dr[id];
        }
      }
      if (Object.keys(dr).length) state.droppedRetries[f.slug] = dr; else delete state.droppedRetries[f.slug];
      // Advance only up to (not past) the earliest still-retriable dropped trigger; a clean
      // run with no retriable drops advances fully. A hard failure above already `continue`d,
      // so reaching here means the extraction itself succeeded.
      state.cursors[f.slug] = blockingId != null ? Math.min(f.hi, blockingId - 1) : f.hi;
    }
  } finally {
    if (cdb) try { cdb.close(); } catch { /* closed */ }
  }
  saveState(state);
  console.log(`\ninserted ${inserted} task(s)${actualUsd != null ? ` · actual cost $${actualUsd.toFixed(4)}` : ''}`);
  if (givenUpDrops.length) {
    console.log(`!! ${givenUpDrops.length} trigger(s) given up after ${DROP_MAX_RETRIES} dropped runs (NOT captured): `
      + givenUpDrops.map((d) => `${d.slug}#m${d.msgId}`).join(', '));
  }
  if (write) recordTodoRun(startedAt, scanned, slugs.length, total, inserted, model, captured, actualUsd);
}

// Record the scan in the /admin/runs ledger. Like sweeps, a no-op tick (no
// triggers, nothing inserted) is written but hidden in the UI, so the hourly
// cadence doesn't bury the runs that mattered. Non-fatal.
function recordTodoRun(startedAt, scanned, contacts, triggers, inserted, model = MODEL, captured = [], actualCostUsd = null) {
  // One model call per trigger (each "make sure" line is extracted on its own);
  // a scan with no triggers spends nothing. `costUsd` is an ESTIMATE (lib/cost.js);
  // `actualCostUsd` is the REAL billed figure read back from the model session
  // (null when nothing was captured). Neither is ever fed to the fitted estimator.
  let costUsd = null;
  try {
    const per = require('../lib/cost').shortCallUsd(model, { bucketTokens: 2_000 });
    costUsd = per == null ? null : per * triggers;
  } catch { /* pricing is best-effort */ }
  try {
    require('../lib/run-record').writeRunRecord({
      kind: 'todo',
      startedAt,
      endedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      scanned,
      contacts,
      triggers,
      inserted,
      captured,
      costUsd,
      actualCostUsd,
      costModel: model,
    });
  } catch (e) {
    console.log(`crm-todo-scan: run-record not written (non-fatal): ${e.message}`);
  }
}

if (require.main === module) {
  // Cross-process pipeline lock (see lib/pipeline-lock.js). The hourly scheduled
  // scan must not run concurrently with a web-triggered ingest — two processes
  // touching crm.db, and a duplicate paid extraction. A scheduled loser exits 0.
  const lock = require('../lib/pipeline-lock').acquire('todo');
  if (!lock.ok) { console.log(`crm-todo-scan: skipped, run in progress (${lock.holderDesc}).`); process.exit(0); }
  try { main(); } finally { lock.release(); }
}
module.exports = { renderLedger };
