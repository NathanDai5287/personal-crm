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
  // WAIT FOR THE LOCK instead of dying on it. crm.db is in rollback-journal mode,
  // so any open reader blocks a writer, and node:sqlite's default busy timeout is
  // ZERO — one `/status` page load in the web app was enough to kill a full deep
  // sweep outright ("database is locked", 2026-08-05). Everything that touches
  // this file is either a page render measured in milliseconds or a sweep that
  // can afford to wait, so blocking is always the better answer than failing.
  // Signal's opener has done this since day one (busy_timeout = 5000).
  db.exec('PRAGMA busy_timeout = 15000');
  return db;
}

module.exports = { openSignalDb, openCrmDb };
