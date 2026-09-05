'use strict';
// crm-media-worker.js — drains the media-understanding queue (lib/media.js) out of
// band, so decrypting + reading media never blocks a sweep. Runs ONE item at a time
// and reniced to the floor, so it can't starve the web service on minmus's modest
// CPU. The archive sweep enqueues and fire-and-forgets this; it idle-exits when the
// queue is empty.
//
//   node scripts/crm-media-worker.js                 # drain the queue, then exit
//   node scripts/crm-media-worker.js --enqueue-existing   # seed from all downloaded
//                                                          # image/audio/video, then drain
//   node scripts/crm-media-worker.js --status        # print queue counts and exit
//   node scripts/crm-media-worker.js --max 20        # process at most 20 items
//
// COMPOSITIONAL MODEL (see lib/media.js header). A photo is one visual component
// (-> ocr + caption); an audio note is one audio component (-> stt); a video is BOTH
// an audio component (-> stt) AND N sampled-frame visual components (-> ocr + caption
// each) — the frame rows don't exist until the video's own `caption` row (part 0) is
// claimed and EXPANDS into them (see expandVideoFrames below).
//
// ENGINES (auto-detected; missing engine just leaves that kind pending):
//   OCR     — `tesseract` on PATH (or $CRM_TESSERACT).            [needs: apt tesseract-ocr]
//   STT     — whisper.cpp: $CRM_WHISPER_CLI (the whisper-cli binary) + $CRM_WHISPER_MODEL
//             (a ggml model, e.g. ggml-base.en.bin). Audio is transcoded to 16 kHz mono
//             WAV with ffmpeg ($CRM_FFMPEG, default `ffmpeg`) first, which whisper.cpp needs.
//   CAPTION — moondream (a local VLM) served over Ollama's HTTP API at $CRM_OLLAMA_URL
//             ($CRM_CAPTION_MODEL, default moondream:1.8b-v2-q8_0). Node 24's global
//             fetch talks to it directly — no client library needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { openCrmDb, openSignalDb } = require('../lib/signal-db');
const {
  TESSERACT_BIN, FFMPEG_BIN, WHISPER_CLI, WHISPER_MODEL, DATA_DIR,
  CRM_OLLAMA_URL, CRM_CAPTION_MODEL, CRM_VIDEO_FRAME_SEC, CRM_VIDEO_MAX_FRAMES,
} = require('../lib/config');
const { decryptableByHash, decryptRow } = require('../lib/signal-attachments');
const M = require('../lib/media');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

// SINGLETON LOCK. Every full sweep fire-and-forgets a worker; without this, a slow
// drain (hundreds of items) would have overlapping workers decrypt/OCR the same rows
// and thrash this modest CPU — the "single worker" the comments assumed but never
// enforced. A pidfile with O_EXCL; a dead holder's lock is stolen, a live one makes
// this process exit quietly. Released on exit.
const WORKER_LOCK = path.join(DATA_DIR, 'media-worker.lock');
function pidAlive(pid) { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function acquireWorkerLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(WORKER_LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = () => { try { if (Number(fs.readFileSync(WORKER_LOCK, 'utf8')) === process.pid) fs.unlinkSync(WORKER_LOCK); } catch { /* gone */ } };
      process.on('exit', release);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = 0; try { holder = Number(fs.readFileSync(WORKER_LOCK, 'utf8')); } catch { /* unreadable */ }
      if (pidAlive(holder)) return false;                 // a live worker is draining — defer to it
      try { fs.unlinkSync(WORKER_LOCK); } catch { /* raced */ } // stale (dead holder) — steal and retry
    }
  }
  return false;
}

try { os.setPriority(19); } catch { /* best-effort renice to the floor */ }

const TESSERACT = TESSERACT_BIN;
const FFMPEG = FFMPEG_BIN;

function have(cmd, probe) {
  try { execFileSync(cmd, probe, { stdio: 'ignore', timeout: 15_000 }); return true; } catch { return false; }
}
const ocrOk = () => have(TESSERACT, ['--version']);
// EXECUTABLE + non-empty, not merely present (P4 #5): a half-built / 0-byte whisper-cli
// passed existsSync and then sent every audio row to a terminal error.
function usableBin(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).size > 0; } catch { return false; } }
function nonEmpty(p) { try { return fs.statSync(p).size > 0; } catch { return false; } }
const sttOk = () => Boolean(WHISPER_CLI) && usableBin(WHISPER_CLI)
  && Boolean(WHISPER_MODEL) && nonEmpty(WHISPER_MODEL) && have(FFMPEG, ['-version']);
// Skip audio longer than this (P4 #6): a very long memo would burn the whole whisper
// timeout to a terminal error and stage a huge WAV in /tmp. Override CRM_STT_MAX_SEC.
const STT_MAX_SEC = Number(process.env.CRM_STT_MAX_SEC) || 1200;

// Ollama probe/generate timeouts. Short for the "is it even up" tags check; long for
// generate because a CPU-served VLM genuinely takes tens of seconds per image and a
// short timeout would misreport a slow-but-working engine as broken.
const CAPTION_PROBE_MS = 5_000;
const CAPTION_GENERATE_MS = 180_000;

// Is Ollama up AND actually serving the model we ask for (not just SOME model)? A
// stale/mismatched CRM_CAPTION_MODEL would otherwise get a 404 on every request
// instead of failing fast here and leaving caption rows pending like a missing
// tesseract. On ANY error (down, DNS, timeout, bad JSON) we report false — graceful
// degradation, never a hard failure of the whole worker.
async function captionOk() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CAPTION_PROBE_MS);
  try {
    const res = await fetch(`${CRM_OLLAMA_URL}/api/tags`, { signal: ac.signal });
    if (!res.ok) return false;
    const json = await res.json();
    const models = Array.isArray(json && json.models) ? json.models : [];
    // startsWith, not ===, because Ollama's /api/tags often reports a resolved digest
    // suffix; comparing exactly would false-negative on an otherwise-matching model.
    return models.some((m) => m && typeof m.name === 'string'
      && (m.name === CRM_CAPTION_MODEL || m.name.startsWith(CRM_CAPTION_MODEL)));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Caption one still image via moondream. The prompt is DELIBERATELY a single plain
// sentence — moondream (a small VLM) degrades badly on long/structured/instruction-
// heavy prompts, unlike a full-size model. Keep it that way even under temptation to
// ask for more structure.
async function runCaption(imgPath) {
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CAPTION_GENERATE_MS);
  try {
    const res = await fetch(`${CRM_OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CRM_CAPTION_MODEL,
        prompt: 'Describe this image.',
        images: [b64],
        stream: false,
        options: { temperature: 0, num_ctx: 8192 },
      }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.error) throw new Error(String(json.error));
    return String((json && json.response) || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/bmp': '.bmp', 'image/tiff': '.tiff', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/wav': '.wav',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'video/x-matroska': '.mkv', 'video/3gpp': '.3gp', 'video/mpeg': '.mpeg' };
const extFor = (ct) => EXT[(ct || '').toLowerCase()] || '.bin';

// Decrypt-then-stage-to-disk is shared by every kind (tesseract/whisper.cpp/ollama
// all want a real file, not a Buffer), so it is factored out once here.
function writeTemp(tmpDir, buf, contentType) {
  const p = path.join(tmpDir, `${crypto.randomBytes(8).toString('hex')}${extFor(contentType)}`);
  fs.writeFileSync(p, buf);
  return p;
}

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
    try {
      // Capture stderr so a NO-AUDIO input (a silent video / muted clip / GIF-as-mp4)
      // can be told apart from a real transcode failure.
      execFileSync(FFMPEG, ['-y', '-i', file, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000, encoding: 'utf8' });
    } catch (e) {
      const err = String((e && e.stderr) || (e && e.message) || '');
      // A clip with no audio stream is not a failure — there is nothing to transcribe.
      // Signal it so the caller records 'skip', not a permanent 'error' that inflates
      // the error count and burns a retry on every --retry-errors.
      if (/does not contain any stream|matches no streams/i.test(err)) {
        const noAudio = new Error('no audio track');
        noAudio.code = 'NO_AUDIO';
        throw noAudio;
      }
      throw e;
    }
    const out = execFileSync(WHISPER_CLI, ['-m', WHISPER_MODEL, '-f', wav, '-nt', '-np'],
      { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.replace(/\s+/g, ' ').trim();
  } finally {
    try { fs.unlinkSync(wav); } catch { /* gone */ }
  }
}

// Sample frames out of a decrypted video with ffmpeg (1 frame per CRM_VIDEO_FRAME_SEC,
// capped at CRM_VIDEO_MAX_FRAMES so a long video can't explode into hundreds of jobs).
// `:round=up` is essential — a plain `fps=1/10` emits ZERO frames for any clip shorter
// than one sample interval (a 2s / 4s chat clip → nothing), silently losing all visual
// context; round=up guarantees at least one frame for every video. Returns the sorted
// list of frame filenames. THROWS if ffmpeg itself fails (missing binary, timeout, a
// transcode error) — the caller turns that into a RECOVERABLE `error` (retriable once
// ffmpeg is installed/fixed), NOT a permanent `skip`. An empty return means ffmpeg ran
// fine but produced no frames (a genuinely decode-less file) — that IS a skip.
function extractFrames(videoPath, frameDir) {
  execFileSync(FFMPEG, ['-y', '-i', videoPath, '-vf', `fps=1/${CRM_VIDEO_FRAME_SEC}:round=up`,
    '-frames:v', String(CRM_VIDEO_MAX_FRAMES), path.join(frameDir, 'frame_%03d.png')],
  { stdio: 'ignore', timeout: 180_000 });
  try { return fs.readdirSync(frameDir).filter((f) => /^frame_\d+\.png$/.test(f)).sort(); } catch { return []; }
}

const engineFor = (kind) => (kind === 'ocr' ? 'tesseract'
  : kind === 'stt' ? `whisper.cpp ${path.basename(WHISPER_MODEL || 'whisper')}`
    : `moondream ${CRM_CAPTION_MODEL}`);

// Is this exact (hash, kind, part) already finished? Used so a video RE-expansion (a
// per-frame retry) doesn't redo frames that already succeeded — only the failed/missing
// ones are re-run.
function alreadyDone(cdb, k) {
  try {
    const r = cdb.prepare("SELECT status FROM media_text WHERE hash = ? AND kind = ? AND part = ?").get(k.hash, k.kind, k.part);
    return Boolean(r) && r.status === 'done';
  } catch { return false; }
}

// The video's own `caption` row (part 0) is a TRIGGER, not a real caption job: claiming
// it means "this video hasn't been decomposed into frames yet". Sample frames, enqueue
// + immediately process an {ocr, caption} pair for each one (part 1..N), then close out
// the trigger row as 'skip' so it never gets reclaimed. `kinds` gates which per-frame
// extractors actually run (engine availability + any --kinds filter).
//
// RE-ENTRANT / RETRIABLE. This is also how a per-frame failure recovers: if a frame's
// caption/ocr errored (or a crash stranded a frame row 'pending'/'processing'), that
// part>0 row is later re-claimed and processOne calls back here to re-expand — frames
// already 'done' are skipped (alreadyDone), so only the missing ones re-run. Since
// claimNext only ever offers a kind whose engine is available, a re-claimed frame's
// kind can always run, so this reaches a terminal state and cannot loop.
async function expandVideoFrames(cdb, claim, row, tmpDir, kinds) {
  const triggerKey = { hash: claim.hash, kind: 'caption', part: 0 };
  const label = claim.hash.slice(0, 12);
  let videoBuf = decryptRow(row);
  const videoTmp = writeTemp(tmpDir, videoBuf, claim.content_type);
  videoBuf = null; // the bytes are on disk now; don't pin ~100 MB across minutes of per-frame captioning
  const frameDir = fs.mkdtempSync(path.join(tmpDir, 'frames-'));
  try {
    let frames;
    try {
      frames = extractFrames(videoTmp, frameDir);
    } catch (e) {
      // ffmpeg missing / timed out / transcode error — RECOVERABLE. Mark the trigger
      // 'error' (not 'skip') so `--retry-errors` re-expands once ffmpeg is available;
      // a permanent skip would strand the whole video's visuals forever.
      M.setError(cdb, triggerKey, `frame extraction failed: ${e.message}`, engineFor('caption'));
      console.log(`  caption ${label}… -> ERROR frame extraction: ${String(e.message).slice(0, 120)}`);
      return;
    }
    if (!frames.length) {
      M.setSkip(cdb, triggerKey, 'no frames extracted');
      console.log(`  caption ${label}… -> skipped (no frames extracted)`);
      return;
    }
    for (let i = 0; i < frames.length; i += 1) {
      const part = i + 1; // frame parts start at 1; 0 is reserved for the trigger row
      const framePath = path.join(frameDir, frames[i]);
      // Each frame's two extractors are wrapped individually — one bad frame (a
      // corrupt PNG, a moondream timeout) must not abort the rest of the video.
      if (kinds.includes('caption')) {
        const key = { hash: claim.hash, kind: 'caption', part };
        M.enqueue(cdb, { hash: claim.hash, kind: 'caption', part, contentType: claim.content_type });
        if (!alreadyDone(cdb, key)) {
          try {
            const text = await runCaption(framePath);
            if (!text) M.setSkip(cdb, key, 'no text extracted');
            else M.setDone(cdb, key, text, engineFor('caption'));
          } catch (e) {
            M.setError(cdb, key, e.message, engineFor('caption'));
            console.log(`  caption ${label}…#${part} -> ERROR ${e.message}`);
          }
        }
      }
      if (kinds.includes('ocr')) {
        const key = { hash: claim.hash, kind: 'ocr', part };
        M.enqueue(cdb, { hash: claim.hash, kind: 'ocr', part, contentType: claim.content_type });
        if (!alreadyDone(cdb, key)) {
          try {
            const text = runOcr(framePath);
            if (!text) M.setSkip(cdb, key, 'no text extracted');
            else M.setDone(cdb, key, text, engineFor('ocr'));
          } catch (e) {
            M.setError(cdb, key, e.message, engineFor('ocr'));
            console.log(`  ocr ${label}…#${part} -> ERROR ${e.message}`);
          }
        }
      }
    }
    M.setSkip(cdb, triggerKey, `expanded into ${frames.length} frame(s)`);
    console.log(`  caption ${label}… -> expanded into ${frames.length} frame(s)`);
  } finally {
    try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.unlinkSync(videoTmp); } catch { /* gone */ }
  }
}

// Scan the Signal DB for every DOWNLOADED image/audio/video attachment and enqueue its
// full DECOMPOSITION: image -> ocr(0)+caption(0); audio -> stt(0); video -> stt(0) (its
// audio track) + caption(0) (the frame-expansion trigger — see expandVideoFrames).
// Idempotent (enqueue is INSERT OR IGNORE), so this is also the deep-sweep refill.
function enqueueExisting(cdb, sdb) {
  const rows = sdb.prepare(
    `SELECT DISTINCT plaintextHash AS hash, contentType FROM message_attachments
      WHERE path IS NOT NULL AND localKey IS NOT NULL AND plaintextHash IS NOT NULL
        AND attachmentType = 'attachment'
        AND (contentType LIKE 'image/%' OR contentType LIKE 'audio/%' OR contentType LIKE 'video/%')`,
  ).all();
  let n = 0;
  for (const r of rows) {
    const ct = r.contentType || '';
    const lc = ct.toLowerCase(); // MIME is case-insensitive; the sweep's mediaJobs matches /i, so match it here too (an 'IMAGE/JPEG' must not be mistaken for a video)
    const kinds = lc.startsWith('image/') ? ['ocr', 'caption']
      : lc.startsWith('audio/') ? ['stt']
        : ['stt', 'caption']; // video
    for (const kind of kinds) {
      if (M.enqueue(cdb, { hash: r.hash, kind, contentType: ct })) n += 1;
    }
  }
  return { scanned: rows.length, added: n };
}

async function processOne(cdb, sdb, kinds, tmpDir) {
  const claim = M.claimNext(cdb, kinds);
  if (!claim) return false;
  const key = { hash: claim.hash, kind: claim.kind, part: claim.part };
  const ct = claim.content_type || '';
  const isImage = /^image\//i.test(ct);
  const isVideo = /^video\//i.test(ct);
  const label = claim.hash.slice(0, 12);
  const partSuffix = claim.part ? `#${claim.part}` : '';
  let tmp = null;
  try {
    const row = decryptableByHash(sdb, claim.hash);
    if (!row) { M.setSkip(cdb, key, 'attachment no longer on disk'); return true; }

    if (claim.kind === 'stt') {
      // stt applies to a whole audio track OR a video's audio track — always part 0.
      // Duration cap (P4 #6): a very long clip would burn the whole whisper timeout
      // and stage a huge WAV. Skip it rather than churn to a terminal error.
      if (row.duration != null && row.duration > STT_MAX_SEC) {
        M.setSkip(cdb, key, `too long (${Math.round(row.duration)}s > ${STT_MAX_SEC}s)`);
        console.log(`  ${claim.kind} ${label}… -> skipped (too long)`);
        return true;
      }
      const buf = decryptRow(row);
      tmp = writeTemp(tmpDir, buf, ct);
      const text = runStt(tmp, tmpDir);
      if (!text) M.setSkip(cdb, key, 'no text extracted');
      else M.setDone(cdb, key, text, engineFor('stt'));
      console.log(`  ${claim.kind} ${label}… -> ${text ? `${text.length} chars` : 'empty'}`);
      return true;
    }

    if (claim.kind === 'ocr' && claim.part === 0 && isImage) {
      const buf = decryptRow(row);
      tmp = writeTemp(tmpDir, buf, ct);
      const text = runOcr(tmp);
      if (!text) M.setSkip(cdb, key, 'no text extracted');
      else M.setDone(cdb, key, text, engineFor('ocr'));
      console.log(`  ${claim.kind} ${label}… -> ${text ? `${text.length} chars` : 'empty'}`);
      return true;
    }

    if (claim.kind === 'caption' && claim.part === 0 && isImage) {
      const buf = decryptRow(row);
      tmp = writeTemp(tmpDir, buf, ct);
      const text = await runCaption(tmp);
      if (!text) M.setSkip(cdb, key, 'no text extracted');
      else M.setDone(cdb, key, text, engineFor('caption'));
      console.log(`  ${claim.kind} ${label}… -> ${text ? `${text.length} chars` : 'empty'}`);
      return true;
    }

    if (claim.kind === 'caption' && claim.part === 0 && isVideo) {
      await expandVideoFrames(cdb, claim, row, tmpDir, kinds);
      return true;
    }

    // A VIDEO FRAME job (part>0) surfaced on its own — a per-frame error being retried
    // (--retry-errors), or a row left 'pending'/'processing' by a crash mid-expansion.
    // The frame image isn't persisted, so re-expand the whole video from its trigger;
    // expandVideoFrames skips frames already 'done', so only the missing one(s) re-run.
    // The claimed kind's engine is available by construction (claimNext gates on it),
    // so this terminates rather than looping.
    if (claim.part > 0 && isVideo && (claim.kind === 'caption' || claim.kind === 'ocr')) {
      await expandVideoFrames(cdb, { ...claim, kind: 'caption', part: 0 }, row, tmpDir, kinds);
      return true;
    }

    // Defensive: shouldn't be reachable (enqueueExisting only ever produces the
    // combinations above, and expandVideoFrames enqueues its own frame parts with a
    // matching content_type), but a future caller or a hand-edited row could still
    // land here — record it rather than silently dropping it.
    M.setSkip(cdb, key, `unhandled: ${claim.kind}/${ct || 'unknown'}/part${claim.part}`);
    console.log(`  ${claim.kind} ${label}${partSuffix} -> skipped (unhandled combination)`);
    return true;
  } catch (e) {
    if (e && e.code === 'NO_AUDIO') {
      M.setSkip(cdb, key, 'no audio track');
      console.log(`  ${claim.kind} ${label}… -> skipped (no audio track)`);
    } else {
      M.setError(cdb, key, e.message, engineFor(claim.kind));
      console.log(`  ${claim.kind} ${label}${partSuffix} -> ERROR ${e.message}`);
    }
    return true;
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
  }
}

async function main() {
  const cdb = openCrmDb();
  M.ensureMediaTable(cdb);

  if (has('--status')) { console.log('media_text:', JSON.stringify(M.counts(cdb))); cdb.close(); return; }

  // Singleton: if another worker is already draining, exit quietly (--status above is
  // exempt — it's read-only). The sweep spawns us fire-and-forget, so this is normal.
  if (!acquireWorkerLock()) { console.log('media worker: another instance is running — exiting.'); cdb.close(); return; }

  const sdb = openSignalDb();
  let kinds = [];
  if (ocrOk()) kinds.push('ocr'); else console.log('OCR engine (tesseract) not found — image rows stay pending.');
  if (sttOk()) kinds.push('stt'); else console.log('STT engine (whisper.cpp at CRM_WHISPER_CLI + CRM_WHISPER_MODEL, plus ffmpeg) not found — audio rows stay pending.');
  if (await captionOk()) kinds.push('caption'); else console.log(`Caption engine (Ollama at ${CRM_OLLAMA_URL} serving ${CRM_CAPTION_MODEL}) not found — caption rows stay pending.`);
  // --kinds ocr,stt restricts what this run processes (the rest stays pending) — handy
  // for draining just images, or just voice notes.
  const only = argVal('--kinds', '');
  if (only) kinds = kinds.filter((k) => only.split(',').map((s) => s.trim()).includes(k));

  if (has('--enqueue-existing')) {
    const r = enqueueExisting(cdb, sdb);
    console.log(`enqueue-existing: ${r.added} new of ${r.scanned} downloaded image/audio/video attachments`);
  }

  if (has('--retry-errors')) { const n = M.requeueErrors(cdb); console.log(`re-queued ${n} error row(s)`); }
  const requeued = M.requeueStale(cdb);
  if (requeued) console.log(`requeued ${requeued} stale 'processing' row(s)`);

  if (!kinds.length) { console.log('no engines available — nothing to do.', JSON.stringify(M.counts(cdb))); sdb.close(); cdb.close(); return; }

  const max = Number(argVal('--max', '0')) || Infinity;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-media-'));
  let done = 0;
  try {
    while (done < max) { if (!(await processOne(cdb, sdb, kinds, tmpDir))) break; done += 1; }
  } finally {
    try { fs.rmdirSync(tmpDir); } catch { /* leftover temp cleaned per-item */ }
  }
  console.log(`processed ${done} item(s).`, JSON.stringify(M.counts(cdb)));
  sdb.close();
  cdb.close();
}

if (require.main === module) {
  // main() is async now (captioning talks to Ollama over fetch), so a thrown/rejected
  // promise would otherwise vanish as an unhandled rejection instead of a nonzero exit.
  main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
} else module.exports = { enqueueExisting };
