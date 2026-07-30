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

const CITE_RE = /⟨\s*(m\d+(?:\s*,\s*m\d+)*)\s*⟩/g;

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
  `);
}

// items: [{ id, convId, conversation, slug, sentAt, sender, body }]
function mirrorMessages(cdb, items) {
  if (!items || items.length === 0) return 0;
  ensureMessagesTable(cdb);
  const stmt = cdb.prepare(
    'INSERT OR IGNORE INTO messages (id, conv_id, conversation, contact_slug, sent_at, sender, body) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  let n = 0;
  for (const it of items) {
    stmt.run(it.id, it.convId ?? null, it.conversation ?? null, it.slug ?? null, it.sentAt, it.sender, it.body);
    n++;
  }
  return n;
}

// Pull every distinct cited message id out of a blob of text.
function extractCitations(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(CITE_RE)) {
    for (const part of m[1].split(',')) ids.add(Number(part.trim().slice(1)));
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

module.exports = { ensureMessagesTable, mirrorMessages, extractCitations, validateCitations, CITE_RE };
