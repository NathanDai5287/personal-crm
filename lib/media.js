'use strict';
// lib/media.js — the OCR / speech-to-text store and work queue.
//
// One table in crm.db, `media_text`, that is BOTH the queue and the result store,
// keyed by an attachment's `plaintextHash` (stable identity; identical files share
// one row, so a meme forwarded ten times is transcribed once). A row starts
// 'pending', a worker claims it ('processing'), and finishes 'done' (text) or
// 'error'. The archive sweep enqueues; scripts/crm-media-worker.js drains the
// queue out of band so a slow OCR/transcription never blocks a sweep. The ledger
// and Timeline builders read finished text back by hash and fold it into the line.
//
// This lives in crm.db (not the Signal DB, which we only ever read) so results
// persist with the archive and survive a Signal resync.

function ensureMediaTable(cdb) {
  cdb.exec(`
    CREATE TABLE IF NOT EXISTS media_text (
      hash         TEXT PRIMARY KEY,   -- attachment plaintextHash
      kind         TEXT NOT NULL,      -- 'ocr' (image) | 'stt' (audio)
      content_type TEXT,               -- e.g. image/png, audio/mp4
      status       TEXT NOT NULL,      -- pending | processing | done | error | skip
      engine       TEXT,               -- what produced the text (tesseract / whisper …)
      text         TEXT,               -- extracted text / transcript (NULL until done)
      error        TEXT,               -- last failure, when status='error'
      created_at   INTEGER,
      updated_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_media_text_status ON media_text(status);
  `);
}

// Enqueue an attachment for processing. INSERT OR IGNORE keyed by hash, so
// re-enqueuing an already-seen (or already-done) attachment is free — a deep sweep
// can blindly enqueue everything and only genuinely-new work is added. Returns true
// if a new pending row was created.
function enqueue(cdb, { hash, kind, contentType }, now = Date.now()) {
  if (!hash || (kind !== 'ocr' && kind !== 'stt')) return false;
  const r = cdb.prepare(
    `INSERT OR IGNORE INTO media_text (hash, kind, content_type, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(hash, kind, contentType || null, now, now);
  return (r.changes || 0) > 0;
}

// Claim the oldest pending row whose kind is one the caller can handle, marking it
// 'processing' in one transaction so two workers never grab the same item. Returns
// { hash, kind, content_type } or null when the queue holds no runnable work.
function claimNext(cdb, kinds, now = Date.now()) {
  const list = (Array.isArray(kinds) ? kinds : [kinds]).filter((k) => k === 'ocr' || k === 'stt');
  if (!list.length) return null;
  const inList = list.map(() => '?').join(',');
  cdb.exec('BEGIN IMMEDIATE');
  try {
    const row = cdb.prepare(
      `SELECT hash, kind, content_type FROM media_text
        WHERE status = 'pending' AND kind IN (${inList})
        ORDER BY created_at ASC, hash ASC LIMIT 1`,
    ).get(...list);
    if (!row) { cdb.exec('COMMIT'); return null; }
    cdb.prepare("UPDATE media_text SET status = 'processing', updated_at = ? WHERE hash = ?").run(now, row.hash);
    cdb.exec('COMMIT');
    return row;
  } catch (e) {
    cdb.exec('ROLLBACK');
    throw e;
  }
}

function setDone(cdb, hash, text, engine, now = Date.now()) {
  cdb.prepare("UPDATE media_text SET status = 'done', text = ?, engine = ?, error = NULL, updated_at = ? WHERE hash = ?")
    .run(text == null ? '' : String(text), engine || null, now, hash);
}

function setError(cdb, hash, error, engine, now = Date.now()) {
  cdb.prepare("UPDATE media_text SET status = 'error', error = ?, engine = ?, updated_at = ? WHERE hash = ?")
    .run(String(error).slice(0, 500), engine || null, now, hash);
}

// A permanent no-op result (e.g. an image with no text) — 'done' with empty text is
// fine, but 'skip' records that we looked and there was nothing, so the ledger fold
// can tell "not processed yet" from "processed, nothing there".
function setSkip(cdb, hash, reason, now = Date.now()) {
  cdb.prepare("UPDATE media_text SET status = 'skip', text = '', error = ?, updated_at = ? WHERE hash = ?")
    .run(reason ? String(reason).slice(0, 200) : null, now, hash);
}

// Finished text for a hash, or null when there is none to fold (pending/processing/
// error/skip/absent all yield null so a half-done queue never injects blanks).
function getText(cdb, hash) {
  const r = cdb.prepare("SELECT text FROM media_text WHERE hash = ? AND status = 'done' AND text <> ''").get(hash);
  return r ? r.text : null;
}

// Batch variant for the ledger/Timeline fold: Map<hash, text> for the done ones.
function getTexts(cdb, hashes) {
  const out = new Map();
  const ids = [...new Set((hashes || []).filter(Boolean))];
  if (!ids.length) return out;
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = cdb.prepare(
      `SELECT hash, text FROM media_text WHERE status = 'done' AND text <> '' AND hash IN (${slice.map(() => '?').join(',')})`,
    ).all(...slice);
    for (const r of rows) out.set(r.hash, r.text);
  }
  return out;
}

const FOLD_MAX = 600; // per-attachment cap on folded text, so a long OCR can't bloat a line

// Read-time fold for the ledger + Timeline: given a message's space-separated
// attachment hashes (the `att_hashes` column), return the text to append to its
// line — '' when nothing is transcribed yet. Images read "[image text: …]", voice
// notes "[transcript: "…"]". Hash order (as stored on the message) is preserved.
function foldSuffix(cdb, hashesStr) {
  if (!hashesStr) return '';
  const hashes = String(hashesStr).split(/\s+/).filter(Boolean);
  if (!hashes.length) return '';
  const rows = cdb.prepare(
    `SELECT hash, kind, text FROM media_text WHERE status = 'done' AND text <> '' AND hash IN (${hashes.map(() => '?').join(',')})`,
  ).all(...hashes);
  if (!rows.length) return '';
  const byHash = new Map(rows.map((r) => [r.hash, r]));
  const parts = [];
  for (const h of hashes) {
    const r = byHash.get(h);
    if (!r) continue;
    const t = r.text.replace(/\s+/g, ' ').trim().slice(0, FOLD_MAX);
    if (t) parts.push(r.kind === 'stt' ? `[transcript: "${t}"]` : `[image text: ${t}]`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

// On worker start, return any 'processing' rows to 'pending': a worker that died
// mid-item would otherwise strand them forever. Safe because a single worker runs
// at a time (the sweep starts one, and it idle-exits).
function requeueStale(cdb, now = Date.now()) {
  return cdb.prepare("UPDATE media_text SET status = 'pending', updated_at = ? WHERE status = 'processing'").run(now).changes || 0;
}

// Reset 'error' rows to 'pending' for another attempt (after fixing an engine or a
// bug). Errors are otherwise never re-claimed, so this is opt-in.
function requeueErrors(cdb, now = Date.now()) {
  return cdb.prepare("UPDATE media_text SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'error'").run(now).changes || 0;
}

function counts(cdb) {
  const out = {};
  for (const r of cdb.prepare('SELECT status, count(*) c FROM media_text GROUP BY status').all()) out[r.status] = r.c;
  return out;
}

module.exports = {
  ensureMediaTable, enqueue, claimNext, setDone, setError, setSkip, getText, getTexts, foldSuffix, requeueStale, requeueErrors, counts,
};
