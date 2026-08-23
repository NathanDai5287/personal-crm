// crm-wipe.js — reset an arbitrary set of contacts to a clean slate.
//
// For each named contact (or --all tracked): blank their profile back to a stub,
// clear their MERGE FRONTIER (the `merged` ledger in crm.db), drop their Timeline
// state, and delete their pending refresh ledger. Clearing the frontier is what
// actually arms a rebuild: the planner defines "pending" as archive rows NOT IN
// `merged` (crm-refresh.js), so without it a wiped contact re-ingests NOTHING and
// its profile stays a stub forever. Only the DERIVED ledger is cleared — the
// append-only MESSAGE ARCHIVE (crm.db's `messages` table) is never touched, so a
// wiped contact rebuilds by re-ingesting from scratch; nothing irreplaceable is lost.
//
// SAFE BY DEFAULT — dry-run unless --write. On --write it first snapshots data/
// into the local history repo (memory-commit) so every wipe has a recovery point;
// if that snapshot fails it aborts before changing anything.
//
// This is the CLI-only destructive reset the dashboard points at ("Destructive
// resets stay on the command line") — deliberately not a UI button.
//
// Usage:
//   node scripts/crm-wipe.js <slug...>                  # preview (dry-run)
//   node scripts/crm-wipe.js <slug...> --write          # wipe those contacts
//   node scripts/crm-wipe.js --all --write              # wipe every tracked contact
//   node scripts/crm-wipe.js --runs --write             # clear the whole runs ledger
//
// A plain wipe already arms a FULL re-ingest: clearing the `merged` frontier means
// the planner sees every archived message as pending, so the next ingest replays
// the contact's entire history. `--backfill` is now redundant (it used to poke the
// retired REFRESH_STATE cursor, which the planner no longer reads) and is accepted
// as a no-op.
//
// --runs is a separate, GLOBAL action (not per-contact): it deletes every record
// under logs/runs/ plus logs/last-run.json — the source of the dashboard's Runs
// page. It can run alone or alongside a contact wipe. Run records are disposable
// logs (not in the history repo), so this is not recoverable.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  ROOT, TRACKED, CONTACTS_DIR, REFRESH_DIR, REFRESH_STATE, TIMELINE_STATE, LOGS_DIR,
} = require('../lib/config');
const { openCrmDb } = require('../lib/signal-db');
const { ensureMessagesTable } = require('../lib/archive');

const STUB_BODY = '## What I know\n_Not yet enriched._\n\n## Timeline\n';
const KNOWN_FLAGS = new Set(['--write', '--all', '--backfill', '--runs']);
const RUNS_DIR = path.join(LOGS_DIR, 'runs');
const LAST_RUN = path.join(LOGS_DIR, 'last-run.json');

// Blank a profile to a stub: keep the mechanical metadata block (name, Signal ID,
// phone, first/last contact, counts), reset the two judged fields, drop every
// model-produced section. Everything from the first "## " heading on is replaced.
function stubProfile(text) {
  const m = /^## /m.exec(text);
  let meta = m ? text.slice(0, m.index) : text;
  meta = meta
    .replace(/^(- \*\*Relationship:\*\*).*$/m, '$1 _TBD_')
    .replace(/^(- \*\*Birthday:\*\*).*$/m, '$1 _unknown_')
    .replace(/\n+$/, '\n'); // collapse trailing blank lines to exactly one newline
  return `${meta}\n${STUB_BODY}`;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function runRecordFiles() {
  try { return fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
}

function main() {
  const argv = process.argv.slice(2);
  for (const a of argv) {
    if (a.startsWith('--') && !KNOWN_FLAGS.has(a)) {
      console.error(`crm-wipe: unknown flag '${a}'\nknown: --all, --write, --backfill, --runs`);
      process.exit(2);
    }
  }
  const write = argv.includes('--write');
  const all = argv.includes('--all');
  const backfill = argv.includes('--backfill');
  const runs = argv.includes('--runs');
  const requested = argv.filter((a) => !a.startsWith('--'));

  const tracked = (readJson(TRACKED, {}).slugs) || [];
  const slugs = all ? tracked.slice() : requested;
  const wantContacts = slugs.length > 0;

  if (!wantContacts && !runs) {
    console.error('usage: node scripts/crm-wipe.js <slug...> [--all] [--backfill] [--runs] [--write]');
    process.exit(2);
  }

  // Only wipe contacts that actually have a profile; warn on the rest.
  const targets = [];
  if (wantContacts) {
    for (const slug of slugs) {
      if (fs.existsSync(path.join(CONTACTS_DIR, `${slug}.md`))) targets.push(slug);
      else console.log(`  skip ${slug}: no profile at data/contacts/${slug}.md`);
    }
    if (!targets.length && !runs) { console.error('crm-wipe: nothing to do.'); process.exit(1); }
  }

  const refresh = readJson(REFRESH_STATE, { cursors: {} });
  if (!refresh.cursors || typeof refresh.cursors !== 'object') refresh.cursors = {};
  const timelineState = readJson(TIMELINE_STATE, {});
  const runFiles = runs ? runRecordFiles() : [];
  const hasLastRun = runs && fs.existsSync(LAST_RUN);

  // The merge frontier lives in crm.db's `merged` ledger (NOT the `messages`
  // archive). Open it to count what a wipe would clear (preview) and to clear it
  // (apply). ensureMessagesTable is idempotent and just guarantees the table.
  const cdb = openCrmDb();
  ensureMessagesTable(cdb);
  const frontierCount = cdb.prepare('SELECT COUNT(*) n FROM merged WHERE slug = ?');

  // ---- plan ----
  console.log(`crm-wipe: ${write ? 'WRITE' : 'DRY-RUN'}`
    + `${targets.length ? ` | ${targets.length} contact(s)` : ''}`
    + `${runs ? ` | runs ledger (${runFiles.length} record${runFiles.length === 1 ? '' : 's'}${hasLastRun ? ' + last-run.json' : ''})` : ''}`);
  for (const slug of targets) {
    const nFrontier = frontierCount.get(slug).n;
    const hadTimeline = Object.prototype.hasOwnProperty.call(timelineState, slug);
    const hadLedger = fs.existsSync(path.join(REFRESH_DIR, `${slug}.new.txt`));
    console.log(`  ${slug}: profile -> stub · merge frontier ${nFrontier ? `clear ${nFrontier} row(s) (full re-ingest armed)` : 'none'}`
      + `${hadTimeline ? ' · timeline state removed' : ''}${hadLedger ? ' · pending ledger removed' : ''}`);
  }
  if (runs) console.log(`  runs: remove ${runFiles.length} record(s) from logs/runs/${hasLastRun ? ' + last-run.json' : ''}`);

  if (!write) {
    cdb.close();
    console.log('\nDry-run — nothing changed. Re-run with --write to apply. The message archive is never touched (only the derived merge frontier is cleared).');
    return;
  }

  // ---- apply ----
  // Recovery point before touching contact profiles (data/ lives in the history
  // repo). Runs are disposable logs, so a runs-only clear skips the snapshot.
  if (targets.length) {
    try {
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'memory-commit.js'), `pre-wipe snapshot: ${targets.join(' ')}`.slice(0, 180)],
        { cwd: ROOT, stdio: 'inherit' },
      );
    } catch (e) {
      console.error(`crm-wipe: recovery snapshot FAILED, aborting before any change: ${e.message}`);
      process.exit(1);
    }
  }

  const delFrontier = cdb.prepare('DELETE FROM merged WHERE slug = ?');
  let frontierCleared = 0;
  for (const slug of targets) {
    const file = path.join(CONTACTS_DIR, `${slug}.md`);
    fs.writeFileSync(file, stubProfile(fs.readFileSync(file, 'utf8')));
    // Clear the merge frontier — this is what actually arms the re-ingest.
    frontierCleared += delFrontier.run(slug).changes || 0;
    // REFRESH_STATE is the retired cursor file the planner no longer reads; kept
    // tidy for any old tooling that still inspects it, but it does nothing here.
    delete refresh.cursors[slug];
    delete timelineState[slug];
    try { fs.unlinkSync(path.join(REFRESH_DIR, `${slug}.new.txt`)); } catch { /* no pending ledger */ }
  }
  if (targets.length) {
    fs.writeFileSync(REFRESH_STATE, `${JSON.stringify(refresh, null, 2)}\n`);
    fs.writeFileSync(TIMELINE_STATE, `${JSON.stringify(timelineState, null, 2)}\n`);
    console.log(`\ncrm-wipe: wiped ${targets.length} contact(s); cleared ${frontierCleared} merge-frontier row(s) from crm.db`
      + ' (the append-only message archive is untouched). The next ingest replays their FULL archived history —'
      + ' Ingest on their card, or node scripts/crm-daily.js --only <slug>.');
  }

  if (runs) {
    let removed = 0;
    for (const f of runRecordFiles()) {
      try { fs.unlinkSync(path.join(RUNS_DIR, f)); removed += 1; } catch { /* skip */ }
    }
    try { fs.unlinkSync(LAST_RUN); } catch { /* none */ }
    console.log(`crm-wipe: cleared runs ledger — removed ${removed} record(s).`);
  }
  cdb.close();
}

if (require.main === module) main();
module.exports = { stubProfile };
