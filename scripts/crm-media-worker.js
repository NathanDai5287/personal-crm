'use strict';
// crm-media-worker.js — drains the OCR / speech-to-text queue (lib/media.js) out of
// band, so decrypting + reading media never blocks a sweep. Runs ONE item at a time
// and reniced to the floor, so it can't starve the web service on minmus's modest
// CPU. The archive sweep enqueues and fire-and-forgets this; it idle-exits when the
// queue is empty.
//
//   node scripts/crm-media-worker.js                 # drain the queue, then exit
//   node scripts/crm-media-worker.js --enqueue-existing   # seed from all downloaded
//                                                          # image/audio, then drain
//   node scripts/crm-media-worker.js --status        # print queue counts and exit
//   node scripts/crm-media-worker.js --max 20        # process at most 20 items
//
// ENGINES (auto-detected; missing engine just leaves that kind pending):
//   OCR  — `tesseract` on PATH (or $CRM_TESSERACT).            [needs: apt tesseract-ocr]
//   STT  — whisper.cpp: $CRM_WHISPER_CLI (the whisper-cli binary) + $CRM_WHISPER_MODEL
//          (a ggml model, e.g. ggml-base.en.bin). Audio is transcoded to 16 kHz mono
//          WAV with ffmpeg ($CRM_FFMPEG, default `ffmpeg`) first, which whisper.cpp needs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { openCrmDb, openSignalDb } = require('../lib/signal-db');
const { TESSERACT_BIN, FFMPEG_BIN, WHISPER_CLI, WHISPER_MODEL } = require('../lib/config');
const { decryptableByHash, decryptRow } = require('../lib/signal-attachments');
const M = require('../lib/media');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

try { os.setPriority(19); } catch { /* best-effort renice to the floor */ }

const TESSERACT = TESSERACT_BIN;
const FFMPEG = FFMPEG_BIN;

function have(cmd, probe) {
  try { execFileSync(cmd, probe, { stdio: 'ignore', timeout: 15_000 }); return true; } catch { return false; }
}
const ocrOk = () => have(TESSERACT, ['--version']);
const sttOk = () => Boolean(WHISPER_CLI) && fs.existsSync(WHISPER_CLI)
  && Boolean(WHISPER_MODEL) && fs.existsSync(WHISPER_MODEL) && have(FFMPEG, ['-version']);

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/bmp': '.bmp', 'image/tiff': '.tiff', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/wav': '.wav' };
const extFor = (ct) => EXT[(ct || '').toLowerCase()] || '.bin';

function runOcr(file) {
  // tesseract writes plain text to stdout with the `stdout` output arg.
  const out = execFileSync(TESSERACT, [file, 'stdout', '--psm', '3'],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return out.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function runStt(file, tmpDir) {
  // whisper.cpp needs 16 kHz mono PCM WAV; transcode the decrypted media first.
  const wav = path.join(tmpDir, `${path.basename(file)}.wav`);
  try {
    execFileSync(FFMPEG, ['-y', '-i', file, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
      { stdio: 'ignore', timeout: 120_000 });
    const out = execFileSync(WHISPER_CLI, ['-m', WHISPER_MODEL, '-f', wav, '-nt', '-np'],
      { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.replace(/\s+/g, ' ').trim();
  } finally {
    try { fs.unlinkSync(wav); } catch { /* gone */ }
  }
}

// Scan the Signal DB for every DOWNLOADED image/audio attachment and enqueue it.
// Idempotent (enqueue is INSERT OR IGNORE), so this is also the deep-sweep refill.
function enqueueExisting(cdb, sdb) {
  const rows = sdb.prepare(
    `SELECT DISTINCT plaintextHash AS hash, contentType FROM message_attachments
      WHERE path IS NOT NULL AND localKey IS NOT NULL AND plaintextHash IS NOT NULL
        AND attachmentType = 'attachment'
        AND (contentType LIKE 'image/%' OR contentType LIKE 'audio/%')`,
  ).all();
  let n = 0;
  for (const r of rows) {
    const kind = r.contentType.startsWith('audio/') ? 'stt' : 'ocr';
    if (M.enqueue(cdb, { hash: r.hash, kind, contentType: r.contentType })) n += 1;
  }
  return { scanned: rows.length, added: n };
}

function processOne(cdb, sdb, kinds, tmpDir) {
  const claim = M.claimNext(cdb, kinds);
  if (!claim) return false;
  const engine = claim.kind === 'ocr' ? 'tesseract' : `whisper.cpp ${path.basename(WHISPER_MODEL || 'whisper')}`;
  let tmp = null;
  try {
    const row = decryptableByHash(sdb, claim.hash);
    if (!row) { M.setSkip(cdb, claim.hash, 'attachment no longer on disk'); return true; }
    const buf = decryptRow(row);
    tmp = path.join(tmpDir, `${crypto.randomBytes(8).toString('hex')}${extFor(claim.content_type)}`);
    fs.writeFileSync(tmp, buf);
    const text = claim.kind === 'ocr' ? runOcr(tmp) : runStt(tmp, tmpDir);
    if (!text) M.setSkip(cdb, claim.hash, 'no text extracted');
    else M.setDone(cdb, claim.hash, text, engine);
    console.log(`  ${claim.kind} ${claim.hash.slice(0, 12)}… -> ${text ? `${text.length} chars` : 'empty'}`);
  } catch (e) {
    M.setError(cdb, claim.hash, e.message, engine);
    console.log(`  ${claim.kind} ${claim.hash.slice(0, 12)}… -> ERROR ${e.message}`);
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
  }
  return true;
}

function main() {
  const cdb = openCrmDb();
  M.ensureMediaTable(cdb);

  if (has('--status')) { console.log('media_text:', JSON.stringify(M.counts(cdb))); cdb.close(); return; }

  const sdb = openSignalDb();
  let kinds = [];
  if (ocrOk()) kinds.push('ocr'); else console.log('OCR engine (tesseract) not found — image rows stay pending.');
  if (sttOk()) kinds.push('stt'); else console.log('STT engine (whisper.cpp at CRM_WHISPER_CLI + CRM_WHISPER_MODEL, plus ffmpeg) not found — audio rows stay pending.');
  // --kinds ocr,stt restricts what this run processes (the rest stays pending) — handy
  // for draining just images, or just voice notes.
  const only = argVal('--kinds', '');
  if (only) kinds = kinds.filter((k) => only.split(',').map((s) => s.trim()).includes(k));

  if (has('--enqueue-existing')) {
    const r = enqueueExisting(cdb, sdb);
    console.log(`enqueue-existing: ${r.added} new of ${r.scanned} downloaded image/audio attachments`);
  }

  if (has('--retry-errors')) { const n = M.requeueErrors(cdb); console.log(`re-queued ${n} error row(s)`); }
  const requeued = M.requeueStale(cdb);
  if (requeued) console.log(`requeued ${requeued} stale 'processing' row(s)`);

  if (!kinds.length) { console.log('no engines available — nothing to do.', JSON.stringify(M.counts(cdb))); sdb.close(); cdb.close(); return; }

  const max = Number(argVal('--max', '0')) || Infinity;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-media-'));
  let done = 0;
  try {
    while (done < max) { if (!processOne(cdb, sdb, kinds, tmpDir)) break; done += 1; }
  } finally {
    try { fs.rmdirSync(tmpDir); } catch { /* leftover temp cleaned per-item */ }
  }
  console.log(`processed ${done} item(s).`, JSON.stringify(M.counts(cdb)));
  sdb.close();
  cdb.close();
}

if (require.main === module) main();
else module.exports = { enqueueExisting };
