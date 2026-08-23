'use strict';
// crm-backup.js — snapshot data/crm.db somewhere it cannot be lost with the repo.
//
//   node scripts/crm-backup.js              # take a backup, verify it, prune old ones
//   node scripts/crm-backup.js --check      # report only; exit 1 if the newest is stale
//   node scripts/crm-backup.js --dest <dir>
//
// WHY THIS EXISTS: crm.db is the archive of record. It holds messages Signal has
// since deleted from its own store (disappearing messages, cleared threads), so
// unlike every other file in this project it is NOT regenerable — not from Signal,
// not from the profiles, not from git. It is also deliberately excluded from BOTH
// git repos: the main one has a GitHub remote and must never see private message
// content, and .memory-history.git excludes it because a 20MB binary committed on
// every chunk would make that history unusable. The net effect was that the single
// irreplaceable file in the system had nothing protecting it at all.
//
// WHY OUTSIDE THE PROJECT DIRECTORY: a backup inside data/ is protected against
// corruption but not against the far likelier accident — deleting or re-cloning the
// project tree. Default destination is a sibling of the repo. Override with
// CRM_BACKUP_DIR if you have somewhere better (an external disk, a synced folder).
//
// WHY `VACUUM INTO` RATHER THAN A FILE COPY: a copy taken while a write is in
// flight yields a torn database that looks fine until the day you need it.
// VACUUM INTO runs inside a read transaction, so the output is always a consistent
// snapshot, and it defragments on the way out. node:sqlite's incremental backup()
// would also be correct but is async and does not compact; for 20MB the simpler
// synchronous statement is the better trade.
//
// RETENTION IS TIERED, not "keep the last N". The threat is not only "the file died
// today" but "the file has been quietly wrong for a while and I just noticed" — a
// flat window of dailies would by then contain nothing but copies of the damage.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { CRM_DB, ROOT } = require('../lib/config');
const { fmtLocal } = require('../lib/weeks');

const DEFAULT_DEST = process.env.CRM_BACKUP_DIR
  || path.posix.join(path.posix.dirname(ROOT), 'personal-crm-backups');

// Tiers, oldest-surviving-first. Everything inside the daily window is kept; beyond
// it, one backup per week for KEEP_WEEKLY weeks, then one per month.
const KEEP_DAILY_DAYS = 7;
const KEEP_WEEKLY = 4;
const KEEP_MONTHLY = 6;

const STALE_DAYS = 8;          // --check fails past this
const DAY = 86_400_000;
const NAME_RE = /^crm-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})\.db$/;

// Pacific wall-clock stamp (was host-local, i.e. UTC on minmus). The retention
// reparse (listBackups) reads these parts back only for RELATIVE ordering and
// week/month bucketing, so a single consistent convention is all it needs.
function stamp(d) {
  const [date, time] = fmtLocal(d.getTime()).split(' '); // "YYYY-MM-DD HH:MM" Pacific
  return `crm-${date}T${time.replace(':', '')}.db`;
}

// Parsed from the filename rather than from mtime: a backup dir may be synced,
// copied or restored, any of which rewrites mtime while the name stays truthful.
function listBackups(dest) {
  if (!fs.existsSync(dest)) return [];
  return fs.readdirSync(dest)
    .map((f) => {
      const m = NAME_RE.exec(f);
      if (!m) return null;
      const [, y, mo, d, h, mi] = m;
      return {
        file: f,
        full: path.posix.join(dest, f),
        at: new Date(+y, +mo - 1, +d, +h, +mi),
        size: fs.statSync(path.posix.join(dest, f)).size,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
}

// Row counts of the tables that would actually hurt to lose. A backup that opens
// cleanly but is missing 80,000 messages is worse than an obvious failure, because
// it would silently satisfy every other check here.
function census(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out = {};
    for (const t of ['messages', 'contacts', 'tasks']) {
      try { out[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { out[t] = null; }
    }
    return out;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

function integrityOk(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const r = db.prepare('PRAGMA integrity_check').get();
    return Object.values(r)[0] === 'ok';
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

// Walk newest→oldest and keep the first backup seen in each bucket. Anything that is
// not the representative of its bucket is surplus.
function planPrune(backups, now) {
  const keep = new Set();
  const seenWeek = new Set();
  const seenMonth = new Set();
  let weeks = 0;
  let months = 0;

  for (const b of backups) {
    const ageDays = (now - b.at) / DAY;
    if (ageDays <= KEEP_DAILY_DAYS) { keep.add(b.file); continue; }

    const wk = `${b.at.getFullYear()}-${Math.floor((b.at - new Date(b.at.getFullYear(), 0, 1)) / (7 * DAY))}`;
    if (!seenWeek.has(wk) && weeks < KEEP_WEEKLY) {
      seenWeek.add(wk); weeks += 1; keep.add(b.file); continue;
    }
    const mo = `${b.at.getFullYear()}-${b.at.getMonth()}`;
    if (!seenMonth.has(mo) && months < KEEP_MONTHLY) {
      seenMonth.add(mo); months += 1; keep.add(b.file);
    }
  }
  // Never prune down to nothing, whatever the arithmetic says.
  if (!keep.size && backups.length) keep.add(backups[0].file);
  return backups.filter((b) => !keep.has(b.file));
}

const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

function report(dest, now) {
  const list = listBackups(dest);
  console.log(`dest: ${dest}`);
  if (!list.length) { console.log('NO BACKUPS'); return { list, stale: true }; }
  const total = list.reduce((s, b) => s + b.size, 0);
  const ageDays = (now - list[0].at) / DAY;
  console.log(`${list.length} backup(s), ${mb(total)} total`);
  for (const b of list.slice(0, 5)) {
    console.log(`   ${b.file}  ${mb(b.size)}  ${((now - b.at) / DAY).toFixed(1)}d old`);
  }
  if (list.length > 5) console.log(`   … ${list.length - 5} older`);
  return { list, stale: ageDays > STALE_DAYS, ageDays };
}

function backup(dest, now) {
  if (!fs.existsSync(CRM_DB)) throw new Error(`no database at ${CRM_DB}`);
  fs.mkdirSync(dest, { recursive: true });

  const src = census(CRM_DB);
  const out = path.posix.join(dest, stamp(now));
  // VACUUM INTO refuses to overwrite, which is the behaviour we want — but a leftover
  // file from a crashed run would then block every retry within the same minute.
  const tmp = `${out}.partial`;
  for (const f of [out, tmp]) if (fs.existsSync(f)) fs.unlinkSync(f);

  const db = new DatabaseSync(CRM_DB, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }

  // Verify BEFORE it is named like a real backup, so a bad snapshot can never be
  // mistaken for a good one — and never counts as the recent backup that makes an
  // older, healthy one prunable.
  if (!integrityOk(tmp)) { fs.unlinkSync(tmp); throw new Error('integrity_check failed on the copy'); }
  const copy = census(tmp);
  for (const t of Object.keys(src)) {
    if (src[t] !== copy[t]) {
      fs.unlinkSync(tmp);
      throw new Error(`row count mismatch in ${t}: source ${src[t]}, copy ${copy[t]}`);
    }
  }
  fs.renameSync(tmp, out);

  const size = fs.statSync(out).size;
  console.log(`wrote ${path.basename(out)}  ${mb(size)}  (messages ${src.messages}, contacts ${src.contacts}, tasks ${src.tasks})  verified`);

  const surplus = planPrune(listBackups(dest), now);
  for (const s of surplus) { fs.unlinkSync(s.full); console.log(`   pruned ${s.file}`); }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--dest');
  const dest = i === -1 ? DEFAULT_DEST : argv[i + 1];
  const now = new Date();

  if (argv.includes('--check')) {
    const { stale, ageDays } = report(dest, now);
    if (stale) {
      console.error(ageDays === undefined
        ? 'STALE: no backups at all'
        : `STALE: newest backup is ${ageDays.toFixed(1)}d old (threshold ${STALE_DAYS}d)`);
      process.exit(1);
    }
    return;
  }

  try {
    backup(dest, now);
  } catch (e) {
    console.error(`BACKUP FAILED: ${e.message}`);
    process.exit(1);
  }
  report(dest, now);
}

if (require.main === module) main();
module.exports = { backup, listBackups, planPrune, census, DEFAULT_DEST };
