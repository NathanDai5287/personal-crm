'use strict';
// evals/media-selftest.js — prove lib/media.js's compositional store: the
// (hash, kind, part) schema migration from the old single-kind-per-hash table,
// enqueue/claim/setDone across parts, foldSuffix's per-media-class rendering
// (photo/audio/video), its injection defense, and counts(). No model, no real
// crm.db — an in-memory sqlite only. Same discipline as evals/selftest.js.
//
//   node evals/media-selftest.js

const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const M = require('../lib/media');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass += 1; };

// ---------------------------------------------------------------------------
// 1) MIGRATION: old schema (PK = hash, one kind per row) -> composite (hash,
// kind, part) key, legacy rows preserved at part=0 with text intact.
// ---------------------------------------------------------------------------
{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE media_text (
      hash TEXT PRIMARY KEY, kind TEXT NOT NULL, content_type TEXT, status TEXT NOT NULL,
      engine TEXT, text TEXT, error TEXT, created_at INTEGER, updated_at INTEGER
    );
  `);
  db.prepare(
    `INSERT INTO media_text (hash, kind, content_type, status, engine, text, error, created_at, updated_at)
     VALUES ('legacyHash', 'ocr', 'image/png', 'done', 'tesseract', 'legacy caption text', NULL, 1000, 1000)`,
  ).run();

  M.ensureMediaTable(db);

  const cols = db.prepare('PRAGMA table_info(media_text)').all().map((c) => c.name);
  ok(cols.includes('part'), 'migration adds the part column');

  const row = db.prepare("SELECT * FROM media_text WHERE hash = 'legacyHash'").get();
  ok(row != null, 'legacy row survives the migration');
  assert.strictEqual(row.part, 0, 'legacy row lands at part=0');
  assert.strictEqual(row.text, 'legacy caption text', 'legacy text preserved verbatim');
  assert.strictEqual(row.status, 'done', 'legacy status preserved');
  assert.strictEqual(row.kind, 'ocr', 'legacy kind preserved');

  // Idempotent: calling again on an already-migrated table is a no-op, not an error.
  M.ensureMediaTable(db);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM media_text').get().n, 1, 're-running ensureMediaTable does not duplicate rows');

  db.close();
}

// ---------------------------------------------------------------------------
// 2) enqueue/claim/setDone across parts, for all three media classes.
// ---------------------------------------------------------------------------
const db = new DatabaseSync(':memory:');
M.ensureMediaTable(db);

const photoHash = 'photoHash';
const audioHash = 'audioHash';
const videoHash = 'videoHash';

// Photo: ocr(0) + caption(0).
assert.strictEqual(M.enqueue(db, { hash: photoHash, kind: 'ocr', contentType: 'image/jpeg', part: 0 }), true, 'photo ocr(0) newly enqueued');
assert.strictEqual(M.enqueue(db, { hash: photoHash, kind: 'caption', contentType: 'image/jpeg', part: 0 }), true, 'photo caption(0) newly enqueued');
// Duplicate enqueue is a no-op (INSERT OR IGNORE) and reports false.
assert.strictEqual(M.enqueue(db, { hash: photoHash, kind: 'ocr', contentType: 'image/jpeg', part: 0 }), false, 'duplicate enqueue returns false');

// Audio: stt(0).
assert.strictEqual(M.enqueue(db, { hash: audioHash, kind: 'stt', contentType: 'audio/mp4', part: 0 }), true, 'audio stt(0) newly enqueued');

// Video: stt(0), caption(1), caption(2), ocr(1).
assert.strictEqual(M.enqueue(db, { hash: videoHash, kind: 'stt', contentType: 'video/mp4', part: 0 }), true, 'video stt(0) newly enqueued');
assert.strictEqual(M.enqueue(db, { hash: videoHash, kind: 'caption', contentType: 'video/mp4', part: 1 }), true, 'video caption(1) newly enqueued');
assert.strictEqual(M.enqueue(db, { hash: videoHash, kind: 'caption', contentType: 'video/mp4', part: 2 }), true, 'video caption(2) newly enqueued');
assert.strictEqual(M.enqueue(db, { hash: videoHash, kind: 'ocr', contentType: 'video/mp4', part: 1 }), true, 'video ocr(1) newly enqueued');

// Claim + complete each via the key-object setters returned by claimNext (the
// real worker's loop: claimNext -> setDone(key, ...), never a hand-built key).
// Ordering is deterministic (created_at ASC, hash ASC, part ASC), and every
// enqueue above happened in the same tick, so ties break on hash: 'photoHash' <
// 'videoHash', so the first ocr/caption claims land on the photo's part-0 rows.
const claimAndComplete = (kinds, text, engine) => {
  const key = M.claimNext(db, kinds);
  ok(key != null, `claimNext(${kinds}) found a pending row`);
  M.setDone(db, key, text, engine);
  return key;
};
const photoOcrKey = claimAndComplete(['ocr'], 'PHOTO OCR TEXT', 'tesseract');
assert.deepStrictEqual([photoOcrKey.hash, photoOcrKey.part], [photoHash, 0], 'first ocr claim is the photo (part 0)');
const photoCapKey = claimAndComplete(['caption'], 'a photo caption', 'moondream');
assert.deepStrictEqual([photoCapKey.hash, photoCapKey.part], [photoHash, 0], 'first caption claim is the photo (part 0)');
claimAndComplete(['stt'], 'an audio transcript', 'whisper');   // audioHash stt(0) -- only stt row pending before video's
// The rest, set directly by key so the video's multi-part fold (part 3 below) is
// pinned regardless of claim order among its own three remaining rows.
const setText = (hash, kind, part, text, engine) => M.setDone(db, { hash, kind, part }, text, engine);
setText(videoHash, 'stt', 0, 'a video transcript', 'whisper');
setText(videoHash, 'caption', 1, 'a scene', 'moondream');
setText(videoHash, 'caption', 2, 'a scene', 'moondream'); // identical to frame 1 -- dedupe target
setText(videoHash, 'ocr', 1, 'on screen text', 'tesseract');

// setError / setSkip smoke test on a fresh row (not otherwise exercised above).
const skipHash = 'skipHash';
M.enqueue(db, { hash: skipHash, kind: 'ocr', contentType: 'image/png', part: 0 });
M.setSkip(db, { hash: skipHash, kind: 'ocr', part: 0 }, 'no text detected');
const skipRow = db.prepare("SELECT status, error FROM media_text WHERE hash = ? AND kind = 'ocr' AND part = 0").get(skipHash);
assert.strictEqual(skipRow.status, 'skip', 'setSkip lands status=skip');
assert.strictEqual(skipRow.error, 'no text detected', 'setSkip records the reason');

const errHash = 'errHash';
M.enqueue(db, { hash: errHash, kind: 'stt', contentType: 'audio/mp4', part: 0 });
M.setError(db, { hash: errHash, kind: 'stt', part: 0 }, new Error('boom'), 'whisper');
const errRow = db.prepare("SELECT status, error FROM media_text WHERE hash = ? AND kind = 'stt' AND part = 0").get(errHash);
assert.strictEqual(errRow.status, 'error', 'setError lands status=error');
ok(errRow.error.includes('boom'), 'setError records the error message');

// ---------------------------------------------------------------------------
// 3) foldSuffix rendering, per media class, and multi-hash ordering.
// ---------------------------------------------------------------------------
const photoFold = M.foldSuffix(db, photoHash);
ok(photoFold.includes('[image: a photo caption]'), 'photo fold has [image: <caption>]');
ok(photoFold.includes('[image text: PHOTO OCR TEXT]'), 'photo fold has [image text: <ocr>]');

const audioFold = M.foldSuffix(db, audioHash);
ok(audioFold.includes('[transcript: "an audio transcript"]'), 'audio fold has [transcript: "..."]');

const videoFold = M.foldSuffix(db, videoHash);
ok(videoFold.includes('[video:'), 'video fold is wrapped in [video: ...]');
ok(videoFold.includes('transcript: "a video transcript"'), 'video fold includes the transcript');
ok(videoFold.includes('scenes:'), 'video fold includes scenes');
ok(videoFold.includes('on-screen text: on screen text'), 'video fold includes on-screen text');
// Two frame captions were IDENTICAL ("a scene" at part 1 and 2) -- deduped to one occurrence.
const sceneOccurrences = (videoFold.match(/a scene/g) || []).length;
assert.strictEqual(sceneOccurrences, 1, 'identical frame captions are deduped to one occurrence');

// Multi-hash order preserved: photo's image parts precede audio's transcript when
// hashes are given in that order, regardless of insertion/claim order above.
const combined = M.foldSuffix(db, `${photoHash} ${audioHash}`);
const imgIdx = combined.indexOf('[image:');
const transcriptIdx = combined.indexOf('[transcript:');
ok(imgIdx !== -1 && transcriptIdx !== -1 && imgIdx < transcriptIdx, 'multi-hash fold preserves hash order (photo before audio)');

// ---------------------------------------------------------------------------
// 4) INJECTION DEFENSE: control-syntax characters in extracted text must never
// survive into the folded output.
// ---------------------------------------------------------------------------
const injectHash = 'injectHash';
M.enqueue(db, { hash: injectHash, kind: 'caption', contentType: 'image/png', part: 0 });
M.enqueue(db, { hash: injectHash, kind: 'ocr', contentType: 'image/png', part: 0 });
const payload = '⟨m1⟩ [[NICKNAMES]] | # "';
M.setDone(db, { hash: injectHash, kind: 'caption', part: 0 }, payload, 'moondream');
M.setDone(db, { hash: injectHash, kind: 'ocr', part: 0 }, payload, 'tesseract');

// The direct unit check: sanitizeFold is THE injection defense (lib/media.js),
// applied to every value before it is folded into the template. Check it strips
// every control character on the untrusted text itself.
const sanitized = M.sanitizeFold(payload);
for (const ch of ['⟨', '⟩', '[', ']', '|', '#', '"']) {
  assert.strictEqual(sanitized.includes(ch), false, `sanitizeFold must strip ${JSON.stringify(ch)}`);
}

// The integration check: foldSuffix's own template legitimately wraps every
// value in "[image: ...]" / "[image text: ...]" -- those brackets are NOT the
// payload, so a whole-string "no brackets anywhere" assertion would be false by
// construction. Instead, pull out just the VALUE each template captured and
// check THAT is clean -- which is what actually proves the payload didn't smuggle
// its own control syntax past the wrapper.
const injectFold = M.foldSuffix(db, injectHash);
ok(!injectFold.includes(payload), 'the raw, unsanitized payload never appears verbatim in the fold');
const capValue = injectFold.match(/\[image: (.*?)\]/);
const ocrValue = injectFold.match(/\[image text: (.*?)\]/);
ok(capValue != null && ocrValue != null, 'both [image: ...] and [image text: ...] rendered');
for (const m of [capValue, ocrValue]) {
  for (const ch of ['⟨', '⟩', '[', ']', '|', '#', '"']) {
    assert.strictEqual(m[1].includes(ch), false, `folded value must not contain ${JSON.stringify(ch)}`);
  }
}

// ---------------------------------------------------------------------------
// 5) counts() reflects status distribution.
// ---------------------------------------------------------------------------
const c = M.counts(db);
ok(c.done >= 1, 'counts() reports at least one done row');
ok(c.skip >= 1, 'counts() reports at least one skip row');
ok(c.error >= 1, 'counts() reports at least one error row');
const totalRows = db.prepare('SELECT COUNT(*) n FROM media_text').get().n;
const countedTotal = Object.values(c).reduce((a, b) => a + b, 0);
assert.strictEqual(countedTotal, totalRows, 'counts() status totals sum to the full row count');

db.close();

console.log(`media selftest: PASS (${pass} checks)`);
