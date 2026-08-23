'use strict';
// lib/nicknames.js — the nickname store: the nicknames the model proposed from the
// chats, the ones you have confirmed by hand, and the permanent per-contact denylist
// of dismissed ones. Lives in its own PLAIN node:sqlite DB (data/crm-nicknames.db, see
// config's NICKNAMES_DB), opened exactly like crm.db (a DatabaseSync + a generous
// busy_timeout), so the pipeline keeps sole ownership of crm.db while the web app
// owns this hand-editable data. Every mutation is synchronous.
//
// A nickname carries its proof: the message ids it was seen in (nickname_cite), which
// the profile resolves to citation slips just like a fact bullet. Dismissing one
// deletes it AND records it in nickname_rejected, so the model never re-suggests a
// name you have already thrown away — the denylist is the memory that makes a
// dismissal stick across future ingests.
const { DatabaseSync } = require('node:sqlite');
const { NICKNAMES_DB } = require('./config');

// Nathan backfills profiles without ever reviewing nickname suggestions by hand,
// so a model-proposed nickname is auto-confirmed once it has proof from at least
// this many DISTINCT messages. Two independent sightings is strong enough evidence
// to treat as verified (his call, 2026-08-23 — "just automatically verify after
// the model suggests it twice"). Hand-added names arrive confirmed already;
// dismissed names never reach proposeNickname (the denylist blocks them).
const AUTOCONFIRM_CITES = 2;

// ONE long-lived handle for the process. Deliberately unlike openCrmDb (which
// opens a FRESH connection per call): the web app is long-lived and single-user,
// so a persistent handle is simpler than open/close per request, and the
// busy_timeout covers a stray pipeline reader.
let _db = null;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nickname (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL,          -- the contact this nickname belongs to
      text TEXT NOT NULL,          -- the nickname as written
      status TEXT NOT NULL,        -- 'suggested' (model, unconfirmed) | 'confirmed'
      source TEXT NOT NULL,        -- 'model' (proposed from chats) | 'hand' (added here)
      created_at INTEGER,          -- when the row first appeared
      confirmed_at INTEGER         -- when it became confirmed (NULL while suggested)
    );
    -- Case-insensitive uniqueness PER CONTACT: "Kat" and "kat" are one nickname.
    -- An expression index on lower(text) (node:sqlite supports these) rather than
    -- COLLATE NOCASE so the same rule reads identically in every lookup below.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nickname_slug_ltext ON nickname(slug, lower(text));

    -- The proof: which archive message ids a nickname was seen in. One row per
    -- (nickname, message); INSERT OR IGNORE makes re-proposing the same cite free.
    CREATE TABLE IF NOT EXISTS nickname_cite (
      nickname_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      PRIMARY KEY (nickname_id, message_id)
    );

    -- The permanent denylist: a dismissed nickname, so the model never re-suggests it.
    -- Case-insensitive per contact, via a UNIQUE INDEX on lower(text) — SQLite
    -- disallows an expression inside a table PRIMARY KEY, so the index carries the
    -- constraint instead (same effect as the spec's PRIMARY KEY(slug, lower(text))).
    CREATE TABLE IF NOT EXISTS nickname_rejected (
      slug TEXT NOT NULL,
      text TEXT NOT NULL,
      rejected_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nickname_rejected_slug_ltext ON nickname_rejected(slug, lower(text));
  `);
}

function openNicknamesDb() {
  if (_db) return _db;
  const db = new DatabaseSync(NICKNAMES_DB);
  // Same reasoning as openCrmDb: wait for a lock rather than dying on it.
  db.exec('PRAGMA busy_timeout = 15000');
  ensureSchema(db);
  _db = db;
  return db;
}

// Close and forget the singleton. Mainly for tests (Windows locks an open DB
// file, so the handle must be released before the file can be deleted); harmless
// otherwise — the next call reopens.
function closeNicknamesDb() {
  if (_db) { try { _db.close(); } catch { /* already closed */ } _db = null; }
}

// INSERT OR IGNORE every message id as a cite of `nickId`. Ints only; bad tokens
// are dropped so a stray value can never poison the table.
function addCites(db, nickId, messageIds) {
  if (!messageIds || !messageIds.length) return;
  const ins = db.prepare('INSERT OR IGNORE INTO nickname_cite (nickname_id, message_id) VALUES (?, ?)');
  for (const raw of messageIds) {
    const id = Number(raw);
    if (Number.isInteger(id)) ins.run(nickId, id);
  }
}

// [{ id, text, status, source, cites: [<message_id>, ...] }], confirmed first,
// then oldest-created first. cites are this nickname's message ids, ascending.
function listNicknames(slug) {
  const db = openNicknamesDb();
  const rows = db.prepare(
    `SELECT id, text, status, source FROM nickname WHERE slug = ?
     ORDER BY (status = 'confirmed') DESC, created_at ASC, id ASC`
  ).all(slug);
  const citeStmt = db.prepare('SELECT message_id FROM nickname_cite WHERE nickname_id = ? ORDER BY message_id ASC');
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    status: r.status,
    source: r.source,
    cites: citeStmt.all(r.id).map((c) => c.message_id),
  }));
}

// Model proposal. Never re-suggests a dismissed name (isRejected → null). If the
// nickname already exists for this contact, merge in any new cites and return its id;
// otherwise insert a fresh suggested/model row and its cites. `now` is injectable
// (Date.now() is fine here — this is not a workflow script).
function proposeNickname(slug, text, messageIds, now = Date.now()) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  if (isRejected(slug, t)) return null;
  const db = openNicknamesDb();
  db.exec('BEGIN');
  try {
    let id;
    const existing = db.prepare('SELECT id FROM nickname WHERE slug = ? AND lower(text) = lower(?)').get(slug, t);
    if (existing) {
      id = existing.id;
    } else {
      const r = db.prepare(
        "INSERT INTO nickname (slug, text, status, source, created_at, confirmed_at) VALUES (?, ?, 'suggested', 'model', ?, NULL)"
      ).run(slug, t, now);
      id = Number(r.lastInsertRowid);
    }
    addCites(db, id, messageIds);
    // Auto-confirm a still-suggested name the moment it has enough distinct
    // citations. Only promotes 'suggested' rows; a confirmed or hand row is left
    // as-is. The count is of DISTINCT messages (nickname_cite is unique per
    // (nickname, message)), so re-seeing the same message never inflates it.
    const row = db.prepare('SELECT status FROM nickname WHERE id = ?').get(id);
    if (row && row.status === 'suggested') {
      const n = db.prepare('SELECT COUNT(*) AS c FROM nickname_cite WHERE nickname_id = ?').get(id).c;
      if (n >= AUTOCONFIRM_CITES) {
        db.prepare("UPDATE nickname SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(now, id);
      }
    }
    db.exec('COMMIT');
    return id;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Hand-added nickname — confirmed on arrival. If one already exists for this contact
// (case-insensitively), it is a no-op that returns the existing id. Does NOT
// consult the denylist: a hand-add is a deliberate override. `created_at` and
// `confirmed_at` are both stamped so ordering stays stable.
function addNickname(slug, text, now = Date.now()) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  const db = openNicknamesDb();
  const existing = db.prepare('SELECT id FROM nickname WHERE slug = ? AND lower(text) = lower(?)').get(slug, t);
  if (existing) return existing.id;
  const r = db.prepare(
    "INSERT INTO nickname (slug, text, status, source, created_at, confirmed_at) VALUES (?, ?, 'confirmed', 'hand', ?, ?)"
  ).run(slug, t, now, now);
  return Number(r.lastInsertRowid);
}

// Promote a suggested nickname to confirmed. Slug-scoped: only a row whose slug
// matches is touched, so a mismatched (slug,id) is a no-op. Returns the id, or
// null when nothing changed (unknown id, or the id belongs to another contact).
function confirmNickname(slug, id, now = Date.now()) {
  const db = openNicknamesDb();
  const r = db.prepare("UPDATE nickname SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND slug = ?")
    .run(now, id, slug);
  return r.changes ? id : null;
}

// Rename a nickname, respecting case-insensitive uniqueness within the contact.
// Slug-scoped: the row must belong to `slug` or the whole call no-ops → null. On
// collision with a DIFFERENT existing nickname on the same contact, MERGE: the edited
// row's cites move into the survivor and the edited row is deleted, so the pair
// becomes one (returns the survivor's id). A merge must never lose a
// confirmation — if EITHER the renamed row or the survivor was confirmed, the
// survivor ends up confirmed (keeping its own confirmed_at, else `now`). No
// collision → a plain text update (returns the same id). Missing/empty → null.
function editNickname(slug, id, text, now = Date.now()) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  const db = openNicknamesDb();
  const row = db.prepare('SELECT id, slug, status FROM nickname WHERE id = ? AND slug = ?').get(id, slug);
  if (!row) return null;
  const clash = db.prepare(
    'SELECT id, status, confirmed_at FROM nickname WHERE slug = ? AND lower(text) = lower(?) AND id <> ?'
  ).get(row.slug, t, id);
  db.exec('BEGIN');
  try {
    if (clash) {
      const cites = db.prepare('SELECT message_id FROM nickname_cite WHERE nickname_id = ?').all(id);
      const ins = db.prepare('INSERT OR IGNORE INTO nickname_cite (nickname_id, message_id) VALUES (?, ?)');
      for (const c of cites) ins.run(clash.id, c.message_id);
      db.prepare('DELETE FROM nickname_cite WHERE nickname_id = ?').run(id);
      db.prepare('DELETE FROM nickname WHERE id = ?').run(id);
      // A rename must never silently downgrade a confirmation: if the renamed row
      // or the survivor was confirmed, the survivor stays/becomes confirmed. Keep
      // the survivor's own confirmed_at when it already had one, else stamp now.
      if (row.status === 'confirmed' || clash.status === 'confirmed') {
        db.prepare("UPDATE nickname SET status = 'confirmed', confirmed_at = ? WHERE id = ?")
          .run(clash.confirmed_at || now, clash.id);
      }
      db.exec('COMMIT');
      return clash.id;
    }
    db.prepare('UPDATE nickname SET text = ? WHERE id = ?').run(t, id);
    db.exec('COMMIT');
    return id;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Dismiss a nickname: delete it (and its cites) and record it in the permanent
// denylist so proposeNickname never re-suggests it. Slug-scoped: the row must belong
// to `slug`. Returns true if a row was dismissed, false if the (slug,id) was
// unknown.
function dismissNickname(slug, id, now = Date.now()) {
  const db = openNicknamesDb();
  const row = db.prepare('SELECT slug, text FROM nickname WHERE id = ? AND slug = ?').get(id, slug);
  if (!row) return false;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM nickname_cite WHERE nickname_id = ?').run(id);
    db.prepare('DELETE FROM nickname WHERE id = ?').run(id);
    db.prepare('INSERT OR IGNORE INTO nickname_rejected (slug, text, rejected_at) VALUES (?, ?, ?)')
      .run(row.slug, row.text, now);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Is this nickname on the contact's denylist? Case-insensitive.
function isRejected(slug, text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  const db = openNicknamesDb();
  return !!db.prepare('SELECT 1 AS ok FROM nickname_rejected WHERE slug = ? AND lower(text) = lower(?)').get(slug, t);
}

// Parse the model's emitted nickname block(s). FORMAT — a fenced block:
//
//   [[NICKNAMES]]
//   Name | m123 m456
//   Professor | ⟨m90920⟩ ⟨m90938⟩
//   [[/NICKNAMES]]
//
// Each body line is `<nickname> | <whitespace-separated m<digits> ids>`. Tolerant:
// trims, skips blank lines, ignores a line with no ids, and accepts ⟨m123⟩-style
// tokens (the brackets are stripped). ALL blocks are read, not just the first, so
// a model that emits the block more than once loses nothing. Returns
// [{ text, messageIds:[<int>...] }], or [] when there is no block. Ids are
// extracted as integers.
function parseNicknameProposals(modelText) {
  const s = String(modelText == null ? '' : modelText);
  const out = [];
  for (const block of s.matchAll(/\[\[NICKNAMES\]\]([\s\S]*?)\[\[\/NICKNAMES\]\]/g)) {
    for (const rawLine of block[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const pipe = line.indexOf('|');
      if (pipe === -1) continue;
      const text = line.slice(0, pipe).trim();
      if (!text) continue;
      // Only the id portion (after the pipe) is scanned, so an `m1`-looking nickname
      // can never be misread as an id. ⟨…⟩ brackets fall away naturally.
      const ids = (line.slice(pipe + 1).match(/m\d+/gi) || []).map((tok) => parseInt(tok.slice(1), 10));
      if (!ids.length) continue;
      out.push({ text, messageIds: ids });
    }
  }
  return out;
}

// Parse the model's block(s) and propose each nickname. Returns how many were stored
// (a name on the denylist proposes to null and is not counted). The pipeline owner
// calls this after a merge; it is deliberately NOT wired into crm-merge.js here.
function storeNicknameProposals(slug, modelText, now = Date.now()) {
  let n = 0;
  for (const p of parseNicknameProposals(modelText)) {
    if (proposeNickname(slug, p.text, p.messageIds, now) != null) n += 1;
  }
  return n;
}

module.exports = {
  openNicknamesDb,
  closeNicknamesDb,
  listNicknames,
  proposeNickname,
  addNickname,
  confirmNickname,
  editNickname,
  dismissNickname,
  isRejected,
  parseNicknameProposals,
  storeNicknameProposals,
};
