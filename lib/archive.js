'use strict';
// lib/archive.js — durable local mirror of every Signal message the pipeline
// touches, keyed by Signal's messages.rowid. This is what makes provenance
// citations durable: ledger lines and profile bullets cite `⟨m<rowid>⟩`, the
// web app resolves those ids HERE (not against Signal's DB), so citations
// keep working even if Signal Desktop ever purges or resets its own database.
//
// Both writers mirror what they read:
//   - crm-refresh.js  mirrors every message it puts in a ledger
//   - crm-compact.js  mirrors every message it summarizes into the Timeline
// INSERT OR IGNORE keeps this idempotent — re-pulling the same rows is free.

// The citation grammar — docs/PROVENANCE-SPEC.md §1. Captures 1 = range start,
// 2 = range end (absent for the degenerate single-id form), 3 = the `@` primary
// (absent when there is none). The optional ` ts` time-sensitive flag (merge
// v11) rides last and is display-only — matched here so flagged citations
// still validate and archive, but never captured:
//
//   ⟨m90211-m90219 @m90215⟩   ⟨m90211-m90219⟩   ⟨m88104⟩   ⟨m9651 ts⟩
//
// `## Timeline` is unaffected: it stays single-id by design (spec §5), and a
// single id is a legal degenerate range, so those lines still parse here.
const { ARCHIVE_ID_OFFSET } = require('./config');

const CITE_RE = /⟨\s*m(\d+)(?:-m(\d+))?(?:\s+@m(\d+))?(?:\s+ts)?\s*⟩/g;

function ensureMessagesTable(cdb) {
  cdb.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,     -- Signal messages.rowid
      conv_id TEXT,               -- Signal conversationId (context lookups)
      conversation TEXT,          -- human label: 'DM with X' or the group name
      contact_slug TEXT,          -- tracked contact this was ingested for (nullable)
      sent_at INTEGER NOT NULL,
      sender TEXT NOT NULL,       -- display label, e.g. 'Nathan' or 'Katia'
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_sent ON messages(conv_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_messages_slug_id ON messages(contact_slug, id);
    CREATE INDEX IF NOT EXISTS idx_messages_sent ON messages(sent_at);
  `);
  // src/type let ledger + timeline queries apply the DM/bi-group/multi-group
  // source rules against the ARCHIVE (not Signal), which is what makes the
  // pipeline immune to disappearing messages: once the hourly sweep has a
  // message, merges and timelines can use it even after Signal expires it.
  try { cdb.exec('ALTER TABLE messages ADD COLUMN src TEXT'); } catch { /* exists */ }
  try { cdb.exec("ALTER TABLE messages ADD COLUMN type TEXT"); } catch { /* exists */ }
}

// SIGNAL REUSES ROWIDS, so an archive keyed on rowid cannot be append-only by
// itself. `messages.rowid INTEGER PRIMARY KEY ASC` has no AUTOINCREMENT and no
// sqlite_sequence row (verified 2026-08-05), which means SQLite assigns
// max(rowid)+1 of the rows that *currently exist*. Delete the highest rows —
// exactly what a disappearing-message timer does to the newest messages in the
// table — and the next message Signal receives is handed a rowid the archive
// already holds under a different message.
//
// Without the handling below that costs the NEW message: INSERT OR IGNORE keeps
// the older archived row and silently drops the arrival, and ⟨m<rowid>⟩ becomes
// ambiguous — the archive and Signal disagree about what that id means.
//
// So a rowid whose archived row carries a DIFFERENT sent_at is treated as a
// reused id, and the arrival is stored at rowid + k*SYNTH_BAND instead. sent_at
// is the discriminator because it is the sender's clock stamped at send time,
// never rewritten, and already present on all 83k legacy rows — no migration,
// no new column. Two distinct messages sharing a rowid AND a millisecond is not
// a case worth engineering for.
//
// The band is deterministic (same message -> same synthetic id on every
// re-sweep, so this stays idempotent), sorts after every real id, and preserves
// the relative order of synthetic rows among themselves. Existing citations are
// untouched: the colliding id keeps pointing at the message it always meant.
const SYNTH_BAND = 1_000_000_000;
const SYNTH_MAX_HOPS = 8; // one rowid reused nine times over is a bug, not a case

// items: [{ id, convId, conversation, slug, sentAt, sender, body, src, type }]
// Returns { seen, inserted, collisions: [{ rowid, id, sentAt }] }.
function mirrorMessages(cdb, items) {
  if (!items || items.length === 0) return { seen: 0, inserted: 0, collisions: [] };
  ensureMessagesTable(cdb);
  const stmt = cdb.prepare(
    'INSERT OR IGNORE INTO messages (id, conv_id, conversation, contact_slug, sent_at, sender, body, src, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const at = cdb.prepare('SELECT id, sent_at FROM messages WHERE id = ?');
  // Rows archived before src/type existed keep NULLs on INSERT OR IGNORE, so
  // fill the metadata in when a writer re-sees the row.
  const fill = cdb.prepare('UPDATE messages SET src = ?, type = ? WHERE id = ? AND type IS NULL');
  // ENRICHMENT UPGRADE (the one sanctioned exception to append-only bodies): a
  // captioned photo archived before lib/attachments.js existed holds just the
  // caption, and INSERT OR IGNORE would leave it that way forever. Same for a
  // reply archived before quote context existed, or a bare URL archived before
  // link titles. When a writer re-sees such a row and now has a richer prefix
  // for it, prepend it.
  //
  // Strictly additive — it only fires when the new body ENDS WITH the stored one
  // and is longer, so real message text can never be rewritten or lost. This is
  // what lets enrichments ship incrementally: add a new prefix kind, re-sweep,
  // and existing rows gain it without a migration.
  const upgrade = cdb.prepare(
    'UPDATE messages SET body = ? WHERE id = ? AND body <> ? AND ? LIKE \'%\' || body AND length(?) > length(body)'
  );
  // SECONDARY-DEVICE CONTENT DEDUP. A copied archive keys messages by the ORIGIN
  // device's Signal rowids, so id can't identify a message here. Identity is
  // (sent_at, type): sent_at is the sender's send-instant — stamped once, byte-
  // identical on every linked device and effectively unique (measured: 3 ties in
  // 86k rows) — and type (incoming/outgoing) is always populated and device-
  // stable. We deliberately DON'T key on `sender` (a display label derived per-
  // device from Signal profile names, so it drifts for group members -> the same
  // group message duplicates) nor on `src` (NULL on ~19% of legacy rows -> misses
  // -> duplicates). `type IS ?` is NULL-safe. Only prepared when an offset is set;
  // a primary device (offset 0) keeps the old id-based path untouched.
  const byKey = ARCHIVE_ID_OFFSET
    ? cdb.prepare('SELECT 1 AS ok FROM messages WHERE sent_at = ? AND type IS ? LIMIT 1')
    : null;
  let inserted = 0;
  const collisions = [];
  for (const it of items) {
    // Resolve the id this message may be stored under. A row already holding
    // this id with the SAME sent_at is this same message (re-swept, which is
    // routine) — INSERT OR IGNORE no-ops and the fill/upgrade below still run.
    let id = it.id;
    if (ARCHIVE_ID_OFFSET) {
      // Already hold this message (from the copied primary archive, or an earlier
      // sweep on this machine)? Skip — never a duplicate. Otherwise store it in
      // this device's disjoint offset band so it can't collide with copied ids.
      if (byKey.get(it.sentAt, it.type ?? null)) continue;
      id += ARCHIVE_ID_OFFSET;
    }
    let row = at.get(id);
    if (row && row.sent_at !== it.sentAt) {
      let hops = 0;
      do {
        id += SYNTH_BAND;
        row = at.get(id);
        hops += 1;
      } while (row && row.sent_at !== it.sentAt && hops < SYNTH_MAX_HOPS);
      if (row && row.sent_at !== it.sentAt) {
        // Out of band slots. Refuse rather than overwrite someone's message.
        collisions.push({ rowid: it.id, id: null, sentAt: it.sentAt, dropped: true });
        continue;
      }
      // `row` null here = a genuinely new arrival on a reused rowid; non-null =
      // the same arrival, already rehomed by an earlier sweep.
      if (!row) collisions.push({ rowid: it.id, id, sentAt: it.sentAt });
    }
    const r = stmt.run(id, it.convId ?? null, it.conversation ?? null, it.slug ?? null, it.sentAt, it.sender, it.body, it.src ?? null, it.type ?? null);
    inserted += Number(r.changes || 0);
    if (it.type != null) fill.run(it.src ?? null, it.type, id);
    if (it.enriched) upgrade.run(it.body, id, it.body, it.body, it.body);
  }
  return { seen: items.length, inserted, collisions };
}

// Pull every distinct cited message id out of a blob of text: the ENDPOINTS and
// the PRIMARY, never the interior of a range.
//
// A range's interior was never written by anyone — it is derived by filtering the
// archive to the endpoints' thread — and most of the ids between two endpoints
// belong to OTHER conversations (measured: a contact's own messages are 2-6% of
// their ledger's id span). So harvesting interiors would make validateCitations
// report thousands of "missing" ids that no citation ever claimed.
function extractCitations(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(CITE_RE)) {
    ids.add(Number(m[1]));                            // range start
    if (m[2] !== undefined) ids.add(Number(m[2]));    // range end
    if (m[3] !== undefined) ids.add(Number(m[3]));    // @primary
  }
  return [...ids];
}

// Check that every id cited in `text` exists in the archive. Returns
// { cited, missing } — missing ids are hallucinated or never-mirrored.
function validateCitations(cdb, text) {
  ensureMessagesTable(cdb);
  const ids = extractCitations(text);
  const stmt = cdb.prepare('SELECT 1 AS ok FROM messages WHERE id = ?');
  const missing = ids.filter((id) => !stmt.get(id));
  return { cited: ids.length, missing };
}

module.exports = { ensureMessagesTable, mirrorMessages, extractCitations, validateCitations, CITE_RE, SYNTH_BAND };
