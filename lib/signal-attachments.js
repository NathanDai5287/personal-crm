'use strict';
// lib/signal-attachments.js — read and DECRYPT Signal Desktop's on-disk attachment
// blobs, so OCR/transcription can run over the actual media.
//
// Signal Desktop encrypts every downloaded attachment at rest (schema `version = 2`).
// The on-disk file is the classic Signal attachment envelope:
//
//     IV (16 bytes) ‖ AES-256-CBC ciphertext ‖ HMAC-SHA256 (32 bytes)
//
// The key is the row's base64 `localKey` (64 bytes): the FIRST 32 are the AES-256
// key, the LAST 32 are the HMAC key. The MAC covers (IV ‖ ciphertext). After
// CBC-decrypt (PKCS7 stripped by Node), the plaintext is still padded to Signal's
// size-obfuscation bucket, so we truncate to the row's `size` (true byte length).
// Format verified empirically against real image + audio blobs (PNG/ftyp magic,
// MAC valid) on 2026-08-23.
//
// Only DOWNLOADED attachments (path IS NOT NULL) exist on disk; undownloaded ones
// have path NULL and can't be processed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ATTACHMENTS_DIR } = require('./config');

// Real user media only (matches lib/attachments REAL_TYPES); an attachment identity
// is its plaintextHash — stable across re-downloads and shared by identical files,
// so OCR/transcription dedupes naturally.
function decryptableByHash(sdb, hash) {
  return sdb.prepare(
    `SELECT path, size, localKey, contentType, duration
       FROM message_attachments
      WHERE plaintextHash = ? AND path IS NOT NULL AND localKey IS NOT NULL
      LIMIT 1`,
  ).get(hash) || null;
}

// Decrypt one attachment row ({ path, size, localKey }) to a plaintext Buffer.
// Throws on a missing file, a short file, a bad key, or a MAC mismatch (a MAC
// mismatch means the bytes are not what the key/DB says — never silently trust it).
function decryptRow(row) {
  if (!row || !row.path || !row.localKey) throw new Error('attachment not on disk (no path/localKey)');
  const key = Buffer.from(row.localKey, 'base64');
  if (key.length !== 64) throw new Error(`unexpected localKey length ${key.length} (want 64)`);
  const aesKey = key.subarray(0, 32);
  const macKey = key.subarray(32, 64);

  const file = path.join(ATTACHMENTS_DIR, row.path);
  const buf = fs.readFileSync(file);
  if (buf.length < 16 + 32 + 16) throw new Error(`attachment file too short (${buf.length} bytes)`);

  const iv = buf.subarray(0, 16);
  const theirMac = buf.subarray(buf.length - 32);
  const cipher = buf.subarray(16, buf.length - 32);

  const ourMac = crypto.createHmac('sha256', macKey).update(buf.subarray(0, buf.length - 32)).digest();
  if (ourMac.length !== theirMac.length || !crypto.timingSafeEqual(ourMac, theirMac)) {
    throw new Error('attachment MAC mismatch — wrong key or corrupt file');
  }

  const d = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  const padded = Buffer.concat([d.update(cipher), d.final()]);
  // Truncate Signal's size-obfuscation padding back to the true plaintext length.
  const size = Number.isInteger(row.size) && row.size >= 0 && row.size <= padded.length ? row.size : padded.length;
  return padded.subarray(0, size);
}

// Convenience: decrypt by hash (resolving the row from the Signal DB first).
function decryptByHash(sdb, hash) {
  const row = decryptableByHash(sdb, hash);
  if (!row) throw new Error(`no downloaded attachment for hash ${hash}`);
  return { buf: decryptRow(row), row };
}

module.exports = { decryptRow, decryptByHash, decryptableByHash };
