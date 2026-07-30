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
  return new DatabaseSync(CRM_DB);
}

module.exports = { openSignalDb, openCrmDb };
