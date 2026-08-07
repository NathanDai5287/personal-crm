// crm-wipe.js — reset an arbitrary set of contacts to a clean slate.
//
// For each named contact (or --all tracked): blank their profile back to a stub,
// drop their ingest cursor and compact state, and delete their pending refresh
// ledger. The message archive (crm.db) is NEVER touched, so a wiped contact can
// be rebuilt simply by re-ingesting — nothing is lost, only the derived profile.
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
//   node scripts/crm-wipe.js <slug> --write --backfill  # wipe + arm a FULL re-ingest
//
// --backfill sets the cursor to 0 instead of removing it, so the next ingest
// replays the contact's ENTIRE archived history (see crm-refresh.js: a cursor of
// 0 means "id > 0" = everything; no cursor means only the last 30 days).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  ROOT, TRACKED, CONTACTS_DIR, REFRESH_DIR, REFRESH_STATE, COMPACT_STATE,
} = require('../lib/config');

const STUB_BODY = '## What I know\n_Not yet enriched._\n\n## Timeline\n';
const KNOWN_FLAGS = new Set(['--write', '--all', '--backfill']);

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

function main() {
  const argv = process.argv.slice(2);
  for (const a of argv) {
    if (a.startsWith('--') && !KNOWN_FLAGS.has(a)) {
      console.error(`crm-wipe: unknown flag '${a}'\nknown: --all, --write, --backfill`);
      process.exit(2);
    }
  }
  const write = argv.includes('--write');
  const all = argv.includes('--all');
  const backfill = argv.includes('--backfill');
  const requested = argv.filter((a) => !a.startsWith('--'));

  const tracked = (readJson(TRACKED, {}).slugs) || [];
  const slugs = all ? tracked.slice() : requested;
  if (!slugs.length) {
    console.error('usage: node scripts/crm-wipe.js <slug...> [--all] [--write] [--backfill]');
    process.exit(2);
  }

  // Only wipe contacts that actually have a profile; warn on the rest.
  const targets = [];
  for (const slug of slugs) {
    if (fs.existsSync(path.join(CONTACTS_DIR, `${slug}.md`))) targets.push(slug);
    else console.log(`  skip ${slug}: no profile at data/contacts/${slug}.md`);
  }
  if (!targets.length) { console.error('crm-wipe: nothing to do.'); process.exit(1); }

  const refresh = readJson(REFRESH_STATE, { cursors: {} });
  if (!refresh.cursors || typeof refresh.cursors !== 'object') refresh.cursors = {};
  const compact = readJson(COMPACT_STATE, {});

  console.log(`crm-wipe: ${write ? 'WRITE' : 'DRY-RUN'} | ${targets.length} contact(s)`
    + `${backfill ? ' | --backfill (arm full re-ingest)' : ''}`);
  for (const slug of targets) {
    const hadCursor = Object.prototype.hasOwnProperty.call(refresh.cursors, slug);
    const hadCompact = Object.prototype.hasOwnProperty.call(compact, slug);
    const hadLedger = fs.existsSync(path.join(REFRESH_DIR, `${slug}.new.txt`));
    const cursorAfter = backfill ? 'set to 0 (full backfill armed)' : (hadCursor ? 'removed' : 'none');
    console.log(`  ${slug}: profile -> stub · cursor ${cursorAfter}`
      + `${hadCompact ? ' · compact state removed' : ''}${hadLedger ? ' · pending ledger removed' : ''}`);
  }

  if (!write) {
    console.log('\nDry-run — nothing changed. Re-run with --write to apply. crm.db is never touched.');
    return;
  }

  // Recovery point BEFORE any destructive write. Abort the whole run if it fails.
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

  for (const slug of targets) {
    const file = path.join(CONTACTS_DIR, `${slug}.md`);
    fs.writeFileSync(file, stubProfile(fs.readFileSync(file, 'utf8')));
    if (backfill) refresh.cursors[slug] = 0;
    else delete refresh.cursors[slug];
    delete compact[slug];
    try { fs.unlinkSync(path.join(REFRESH_DIR, `${slug}.new.txt`)); } catch { /* no pending ledger */ }
  }
  fs.writeFileSync(REFRESH_STATE, `${JSON.stringify(refresh, null, 2)}\n`);
  fs.writeFileSync(COMPACT_STATE, `${JSON.stringify(compact, null, 2)}\n`);

  console.log(`\ncrm-wipe: wiped ${targets.length} contact(s). Rebuild by re-ingesting`
    + ' (Ingest on their card, or node scripts/crm-daily.js --only <slug>).');
  if (backfill) console.log('crm-wipe: cursors set to 0 — the next ingest replays their FULL archived history.');
}

if (require.main === module) main();
module.exports = { stubProfile };
