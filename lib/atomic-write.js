'use strict';
// lib/atomic-write.js — one crash-safe file writer for every state file in the repo.
//
// WHY. A bare fs.writeFileSync truncates the target and then streams bytes into it:
// a crash, disk-full, or a concurrent reader hitting that instant sees a TORN file —
// empty or half-written. For crm's state files that is not cosmetic: a torn
// crm-tracked.json reads back as {slugs:[]} and silently untracks everyone; a torn
// TIMELINE_STATE reads back as {} and punches a permanent hole in the timeline; a torn
// censor-rules.json falls back to defaults and lets the next paid-model egress out
// UNCENSORED. The fix is the same everywhere: write a sibling temp file, then rename it
// over the target. rename(2) is atomic within a filesystem, so a reader sees either the
// whole old file or the whole new one — never a half.
//
// This centralises the tmp+rename pattern that was previously inlined in
// crm-archive.js, crm-daily.js, lib/run-record.js, lib/run-toggles.js and
// lib/censor-hold.js. The temp name carries pid + timestamp so two writers (e.g. the
// web process and a pipeline child) can never collide on the same temp path.
const fs = require('fs');

// Atomically write `data` (a string or Buffer) to `file`. Creates parent dirs? No —
// callers that need the dir created do it explicitly (matches the old inline callers).
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    // Never leave the temp file behind on a failed write.
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

// Atomically write `obj` as pretty JSON. The one-JSON-writer the whole repo shares.
function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}`);
}

module.exports = { writeFileAtomic, writeJsonAtomic };
