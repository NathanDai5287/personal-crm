'use strict';
// lib/media.js — the media-understanding store and work queue.
//
// COMPOSITIONAL MODEL (see docs/media-understanding-design.md). Every media item
// decomposes into a small set of COMPONENTS, and each component is reduced to TEXT
// by one of two extractor families — the merge model only ever reads text, never
// pixels or waveforms:
//   visual (a still frame) -> OCR (verbatim text in the image) + CAPTION (a scene
//                             description from a local VLM)
//   audio  (a sound track) -> STT (transcript)
// So:  photo = 1 visual -> {ocr, caption}
//      audio = 1 audio   -> {stt}
//      video = N frames (each a visual -> {ocr, caption}) + 1 audio -> {stt}
//
// One table in crm.db, `media_text`, that is BOTH the queue and the result store.
// Keyed by (hash, kind, part): `hash` is the attachment's plaintextHash (stable
// identity — identical files share it, so a meme forwarded ten times is processed
// once); `kind` is the extractor ('ocr' | 'caption' | 'stt'); `part` is the
// component index — 0 for a whole still image or an audio track, 1..N for a video's
// sampled frames. A row starts 'pending', a worker claims it ('processing'), and
// finishes 'done' (text) | 'skip' (looked, nothing there) | 'error'. The archive
// sweep enqueues; scripts/crm-media-worker.js drains the queue out of band so a slow
// OCR/caption/transcription never blocks a sweep. foldSuffix reads finished text back
// by hash and folds it into the ledger/Timeline line.
//
// This lives in crm.db (not the Signal DB, which we only ever read) so results persist
// with the archive and survive a Signal resync.

const KINDS = ['ocr', 'caption', 'stt'];
const isKind = (k) => KINDS.includes(k);

// Create the table on a fresh install, and MIGRATE the pre-`part` schema (PK was
// `hash`, one kind per row) to the composite (hash, kind, part) key. The migration
// is safe: every legacy row has a unique hash and a single kind, so each maps to
// (hash, kind, 0) with no collision. Runs in one transaction; idempotent.
function ensureMediaTable(cdb) {
  cdb.exec(`
    CREATE TABLE IF NOT EXISTS media_text (
      hash         TEXT NOT NULL,      -- attachment plaintextHash
      kind         TEXT NOT NULL,      -- 'ocr' | 'caption' (image) | 'stt' (audio)
      part         INTEGER NOT NULL DEFAULT 0, -- 0 = whole still/audio; 1..N = video frame
      content_type TEXT,               -- e.g. image/png, audio/mp4, video/mp4
      status       TEXT NOT NULL,      -- pending | processing | done | error | skip
      engine       TEXT,               -- what produced the text (tesseract / whisper / moondream)
      text         TEXT,               -- extracted text / transcript / caption (NULL until done)
      error        TEXT,               -- last failure, when status='error' (or skip reason)
      created_at   INTEGER,
      updated_at   INTEGER,
      PRIMARY KEY (hash, kind, part)
    );
    CREATE INDEX IF NOT EXISTS idx_media_text_status ON media_text(status);
  `);
  // Legacy table (pre-part) still present? It was created before this CREATE, so
  // IF NOT EXISTS was a no-op and it keeps the old single-column PK. Rebuild it.
  let cols = [];
  try { cols = cdb.prepare('PRAGMA table_info(media_text)').all().map((c) => c.name); } catch { cols = []; }
  if (cols.length && !cols.includes('part')) {
    cdb.exec('BEGIN IMMEDIATE');
    try {
      // DROP IF EXISTS: a leftover media_text_v2 (from a file-level backup restored
      // mid-migration, or an older aborted attempt) would otherwise make the CREATE
      // throw on every call, permanently bricking the sweep + worker. WHERE hash IS
      // NOT NULL: the OLD `hash TEXT PRIMARY KEY` permitted NULLs (a SQLite quirk),
      // but the new `hash TEXT NOT NULL` rejects them — one such legacy row would fail
      // the whole migration forever. Dropping those rows (they were never valid queue
      // items) is strictly better than re-throwing on every startup.
      cdb.exec(`
        DROP TABLE IF EXISTS media_text_v2;
        CREATE TABLE media_text_v2 (
          hash TEXT NOT NULL, kind TEXT NOT NULL, part INTEGER NOT NULL DEFAULT 0,
          content_type TEXT, status TEXT NOT NULL, engine TEXT, text TEXT, error TEXT,
          created_at INTEGER, updated_at INTEGER,
          PRIMARY KEY (hash, kind, part)
        );
        INSERT INTO media_text_v2 (hash, kind, part, content_type, status, engine, text, error, created_at, updated_at)
          SELECT hash, kind, 0, content_type, status, engine, text, error, created_at, updated_at FROM media_text WHERE hash IS NOT NULL;
        DROP TABLE media_text;
        ALTER TABLE media_text_v2 RENAME TO media_text;
        CREATE INDEX IF NOT EXISTS idx_media_text_status ON media_text(status);
      `);
      cdb.exec('COMMIT');
    } catch (e) {
      try { cdb.exec('ROLLBACK'); } catch { /* original error wins */ }
      throw e;
    }
  }
}

// Enqueue one component job. INSERT OR IGNORE keyed by (hash, kind, part), so
// re-enqueuing an already-seen (or already-done) job is free — a deep sweep can
// blindly enqueue everything and only genuinely-new work is added. `part` defaults
// to 0 (a whole still image / an audio track). Returns true if a new pending row
// was created.
function enqueue(cdb, { hash, kind, contentType, part = 0 }, now = Date.now()) {
  if (!hash || !isKind(kind)) return false;
  const p = Number.isInteger(part) && part >= 0 ? part : 0;
  const r = cdb.prepare(
    `INSERT OR IGNORE INTO media_text (hash, kind, part, content_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(hash, kind, p, contentType || null, now, now);
  return (r.changes || 0) > 0;
}

// Claim the oldest pending row whose kind is one the caller can handle, marking it
// 'processing' in one transaction so two workers never grab the same item. Returns
// { hash, kind, part, content_type } or null when the queue holds no runnable work.
function claimNext(cdb, kinds, now = Date.now()) {
  const list = (Array.isArray(kinds) ? kinds : [kinds]).filter(isKind);
  if (!list.length) return null;
  const inList = list.map(() => '?').join(',');
  cdb.exec('BEGIN IMMEDIATE');
  try {
    const row = cdb.prepare(
      `SELECT hash, kind, part, content_type FROM media_text
        WHERE status = 'pending' AND kind IN (${inList})
        ORDER BY created_at ASC, hash ASC, part ASC LIMIT 1`,
    ).get(...list);
    if (!row) { cdb.exec('COMMIT'); return null; }
    cdb.prepare("UPDATE media_text SET status = 'processing', updated_at = ? WHERE hash = ? AND kind = ? AND part = ?")
      .run(now, row.hash, row.kind, row.part);
    cdb.exec('COMMIT');
    return row;
  } catch (e) {
    cdb.exec('ROLLBACK');
    throw e;
  }
}

// The terminal-state setters all take a KEY = { hash, kind, part } (the object
// claimNext returned), so a video frame's result lands on its own row.
function setDone(cdb, key, text, engine, now = Date.now()) {
  cdb.prepare("UPDATE media_text SET status = 'done', text = ?, engine = ?, error = NULL, updated_at = ? WHERE hash = ? AND kind = ? AND part = ?")
    .run(text == null ? '' : String(text), engine || null, now, key.hash, key.kind, key.part || 0);
}

function setError(cdb, key, error, engine, now = Date.now()) {
  cdb.prepare("UPDATE media_text SET status = 'error', error = ?, engine = ?, updated_at = ? WHERE hash = ? AND kind = ? AND part = ?")
    .run(String(error).slice(0, 500), engine || null, now, key.hash, key.kind, key.part || 0);
}

// A permanent no-op result (an image with no text, a silent video's audio track) —
// 'skip' records that we looked and there was nothing, so the fold can tell "not
// processed yet" from "processed, nothing there".
function setSkip(cdb, key, reason, now = Date.now()) {
  cdb.prepare("UPDATE media_text SET status = 'skip', text = '', error = ?, updated_at = ? WHERE hash = ? AND kind = ? AND part = ?")
    .run(reason ? String(reason).slice(0, 200) : null, now, key.hash, key.kind, key.part || 0);
}

// Finished text for one (hash, kind, part), or null when there is none to fold.
function getText(cdb, hash, kind = 'ocr', part = 0) {
  const r = cdb.prepare("SELECT text FROM media_text WHERE hash = ? AND kind = ? AND part = ? AND status = 'done' AND text <> ''").get(hash, kind, part);
  return r ? r.text : null;
}

const FOLD_MAX = 600;       // per-attachment cap on folded text, so a long OCR can't bloat a line
const FOLD_FRAME_MAX = 6;   // at most this many distinct frame captions folded per video

// OCR text, captions and transcripts are UNTRUSTED content folded into the shared
// "Rendered" view — a photo of text or a dictated note could carry the ledger's own
// control syntax (`⟨m123⟩` citations, `[[NICKNAMES]]`, a leading `#` header, a `|`
// field split) or a `"` that breaks the transcript wrapper, and try to manipulate a
// merge. Strip those so it can only read as plain quoted content. INJECTION DEFENSE,
// always applied; slur CENSORING is separate (lib/message-context.forModel, egress).
function sanitizeFold(s) {
  return String(s == null ? '' : s).replace(/[⟨⟩[\]|#"]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Dedupe a list of frame strings, dropping consecutive/near-identical repeats (a
// static screen recording captions the same frame N times), preserving order.
function dedupeFrames(list) {
  const out = [];
  const seen = new Set();
  for (const s of list) {
    const norm = s.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(s);
    if (out.length >= FOLD_FRAME_MAX) break;
  }
  return out;
}

// Read-time fold for the ledger + Timeline: given a message's space-separated
// attachment hashes (the `att_hashes` column), return the text to append to its line
// — '' when nothing is transcribed/captioned yet. Renders per media class:
//   photo  ->  [image: <caption>] [image text: <ocr>]
//   audio  ->  [transcript: "<stt>"]
//   video  ->  [video: transcript: "<stt>"; scenes: <cap1> / <cap2> …; on-screen text: <ocr>]
// Hash order (as stored on the message) is preserved.
function foldSuffix(cdb, hashesStr) {
  if (!hashesStr) return '';
  // Dedupe — the same file attached twice shares one plaintextHash, and folding it
  // twice would just burn ledger tokens on a repeat.
  const hashes = [...new Set(String(hashesStr).split(/\s+/).filter(Boolean))];
  if (!hashes.length) return '';
  const rows = cdb.prepare(
    `SELECT hash, kind, part, content_type, text FROM media_text
      WHERE status = 'done' AND text <> '' AND hash IN (${hashes.map(() => '?').join(',')})`,
  ).all(...hashes);
  if (!rows.length) return '';

  const byHash = new Map();
  for (const r of rows) {
    if (!byHash.has(r.hash)) byHash.set(r.hash, []);
    byHash.get(r.hash).push(r);
  }

  const parts = [];
  for (const h of hashes) {
    const rs = byHash.get(h);
    if (!rs) continue;
    // Media class from any row's content_type — but a legacy/hand row can have a NULL
    // or empty content_type, so fall back to the KINDS present: a lone stt row is
    // audio, a caption/ocr row is a photo, any part>0 row is a video. Keying only on
    // content_type (as the first cut did) silently dropped a transcript whose row had
    // no type — a regression vs the old kind-based fold.
    const ct = (rs.find((r) => r.content_type) || {}).content_type || '';
    const stt = rs.find((r) => r.kind === 'stt');
    const capWhole = rs.find((r) => r.kind === 'caption' && r.part === 0);
    const ocrWhole = rs.find((r) => r.kind === 'ocr' && r.part === 0);
    const hasVisual = rs.some((r) => (r.kind === 'caption' || r.kind === 'ocr') && r.part === 0);
    const isVideo = /^video\//i.test(ct) || rs.some((r) => r.part > 0);
    const isAudio = !isVideo && (/^audio\//i.test(ct) || (Boolean(stt) && !hasVisual));

    if (isVideo) {
      // Cap EACH bit before wrapping (never the wrapped string) — slicing the wrapped
      // `[video: …]` dropped the closing `]`/`"` on a long transcript and let it crowd
      // out scenes entirely. Frame lists are part>0 ONLY (the part-0 caption is the
      // expansion trigger, never a real scene).
      const bits = [];
      if (stt) { const t = sanitizeFold(stt.text).slice(0, FOLD_MAX); if (t) bits.push(`transcript: "${t}"`); }
      const frameCaps = dedupeFrames(
        rs.filter((r) => r.kind === 'caption' && r.part > 0).sort((a, b) => a.part - b.part).map((r) => sanitizeFold(r.text)).filter(Boolean),
      );
      if (frameCaps.length) bits.push(`scenes: ${frameCaps.join(' / ').slice(0, FOLD_MAX)}`);
      const frameOcr = dedupeFrames(
        rs.filter((r) => r.kind === 'ocr' && r.part > 0).sort((a, b) => a.part - b.part).map((r) => sanitizeFold(r.text)).filter(Boolean),
      );
      if (frameOcr.length) bits.push(`on-screen text: ${frameOcr.join(' / ').slice(0, FOLD_MAX)}`);
      if (bits.length) parts.push(`[video: ${bits.join('; ')}]`);
    } else if (isAudio) {
      if (stt) { const t = sanitizeFold(stt.text).slice(0, FOLD_MAX); if (t) parts.push(`[transcript: "${t}"]`); }
    } else {
      // photo / still image
      if (capWhole) { const t = sanitizeFold(capWhole.text).slice(0, FOLD_MAX); if (t) parts.push(`[image: ${t}]`); }
      if (ocrWhole) { const t = sanitizeFold(ocrWhole.text).slice(0, FOLD_MAX); if (t) parts.push(`[image text: ${t}]`); }
    }
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

// On worker start, return STALE 'processing' rows to 'pending' — a worker that died
// mid-item would otherwise strand them forever. AGE-GATED (default 30 min): only rows
// whose `processing` claim is older than staleMs are reclaimed, so this can never
// steal an item a live worker is actively processing. Combined with the worker
// singleton lock, concurrent workers shouldn't happen at all; this is the backstop.
function requeueStale(cdb, now = Date.now(), staleMs = 30 * 60 * 1000) {
  return cdb.prepare("UPDATE media_text SET status = 'pending', updated_at = ? WHERE status = 'processing' AND updated_at < ?")
    .run(now, now - staleMs).changes || 0;
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
  KINDS, ensureMediaTable, enqueue, claimNext, setDone, setError, setSkip, getText,
  foldSuffix, sanitizeFold, dedupeFrames, requeueStale, requeueErrors, counts,
};
