'use strict';
// Shared DB openers for the personal-crm pipeline.
const { DatabaseSync } = require('node:sqlite');
const sq = require('../vendor/sqlcipher');
const { rederiveKey } = require('./signal-key');
const { SIGNAL_DB, SIGNAL_KEY_FALLBACK, CRM_DB } = require('./config');

function tryOpenWithKey(key) {
  const db = new sq.Database(SIGNAL_DB, { readonly: true, fileMustExist: true });
  db.pragma(`key = "x'${key}'"`);
  db.pragma('cipher_compatibility = 4');
  db.pragma('busy_timeout = 5000');
  // Verify the key actually decrypts the DB (a wrong key opens "successfully"
  // but throws as soon as a real query touches encrypted pages).
  db.prepare('SELECT count(*) FROM sqlite_master').get();
  return db;
}

function openSignalDb() {
  try {
    return tryOpenWithKey(SIGNAL_KEY_FALLBACK);
  } catch (firstErr) {
    const rederived = rederiveKey();
    if (rederived && rederived !== SIGNAL_KEY_FALLBACK) {
      try {
        return tryOpenWithKey(rederived);
      } catch (secondErr) {
        throw new Error(
          `Failed to open Signal DB with both the fallback key and a rederived key. ` +
            `The Signal cipher key may have rotated. First error: ${firstErr.message}; ` +
            `second error: ${secondErr.message}`
        );
      }
    }
    throw new Error(
      `Failed to open Signal DB with the fallback key, and rederivation ${
        rederived ? 'produced the same (already-failing) key' : 'did not produce a usable key'
      }. The Signal cipher key may have rotated. Original error: ${firstErr.message}`
    );
  }
}

function openCrmDb() {
  const db = new DatabaseSync(CRM_DB);
  // WAIT FOR THE LOCK instead of dying on it. node:sqlite's default busy timeout
  // is ZERO. Set this FIRST so the journal_mode switch below also waits out any
  // conversion race rather than throwing. A page render is milliseconds and a
  // sweep can afford to wait, so blocking always beats failing here.
  db.exec('PRAGMA busy_timeout = 15000');

  // WAL (write-ahead logging). Rollback-journal mode locks the whole file while a
  // write is in flight, so ANY open reader blocks the writer and vice-versa — one
  // `/status` render was once enough to kill a deep sweep ("database is locked",
  // 2026-08-05). WAL appends commits to a `-wal` sidecar; readers read the main
  // file plus the log as of their own snapshot, so readers NEVER block the writer
  // and the writer never blocks readers. That removes the READER/WRITER half of the
  // SQLITE_BUSY class between the web app, the media worker and the pipeline — all
  // same-machine (WAL requires local disk; minmus and duna both qualify). WAL is
  // still single-writer: two concurrent WRITERS (e.g. a sweep INSERT racing a web
  // task-write) still serialize, and the busy_timeout above is what absorbs that.
  //
  // Set on EVERY open, not once: journal_mode is persistent in the file header, so
  // this is a cheap no-op on an already-WAL file — but a database RESTORED from a
  // backup arrives in rollback mode (crm-backup.js writes `VACUUM INTO`, whose
  // output is always a fresh delete-mode db), and re-asserting here silently heals
  // that on first open rather than leaving the live archive un-WAL'd. (A plain
  // VACUUM, by contrast, PRESERVES WAL on this runtime — verified — so it is not
  // the hazard; a restore is.) synchronous=FULL (the SQLite default, made explicit)
  // keeps full durability: every commit fsyncs the -wal, so a power loss loses no
  // committed transaction. NORMAL would trade that for speed we do not need at
  // hourly-sweep volume, and this archive holds Signal-deleted messages — it is
  // irreplaceable, so durability wins.
  const mode = db.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
  db.exec('PRAGMA synchronous = FULL');
  // A contended switch waits (busy_timeout) then throws; but on a read-only
  // directory or a network/synced filesystem the switch fails SILENTLY, returning
  // the old mode with no error — leaving us in rollback with the 2026-08-05 bug
  // still live. Make that loud, once per process, without spamming per request.
  if (mode !== 'wal' && !_walWarned) {
    _walWarned = true;
    console.error(
      `WARNING: crm.db is in "${mode}" mode, not WAL — the switch failed silently. ` +
        `readers and writers will still block each other. Check that data/ is on a ` +
        `local, writable filesystem (WAL is unsafe on network/synced mounts).`
    );
  }
  return db;
}
let _walWarned = false;

module.exports = { openSignalDb, openCrmDb };
