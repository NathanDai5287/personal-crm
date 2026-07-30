'use strict';
// Rederive the Signal Desktop DB cipher key WITHOUT Electron.
//
// Signal Desktop's config.json stores the SQLCipher key hex-encoded under
// `encryptedKey`, "encrypted" via Electron's safeStorage API. On Windows,
// safeStorage is Chromium's OSCrypt, which does NOT encrypt each value
// directly with DPAPI. Instead (confirmed by inspecting both files):
//
//   1. A random AES-256 key (the "OSCrypt master key") is generated once,
//      DPAPI-protected (CurrentUser scope), base64-encoded, and stored in
//      Signal's `Local State` file as `encrypted_key`, itself prefixed with
//      the 5 ASCII bytes "DPAPI" (a Chromium marker, NOT part of the DPAPI
//      blob) before the actual DPAPI ciphertext.
//   2. Each protected value (e.g. config.json's `encryptedKey`) is then
//      AES-256-GCM encrypted with that master key: 3-byte ASCII version
//      prefix ("v10"/"v11") + 12-byte GCM nonce + ciphertext + 16-byte GCM tag.
//
// So rederiving requires: DPAPI-unprotect the master key out of Local State,
// then AES-256-GCM-decrypt config.json's encryptedKey with it. A naive direct
// DPAPI-unprotect of config.json's encryptedKey (as if it were itself a DPAPI
// blob) reliably fails with "the data is invalid", because it isn't one —
// confirmed while building this: neither the raw blob nor the blob with its
// "v10" prefix stripped is a valid DPAPI ciphertext.
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CONFIG_PATH = 'C:/Users/natha/AppData/Roaming/Signal/config.json';
const LOCAL_STATE_PATH = 'C:/Users/natha/AppData/Roaming/Signal/Local State';
const DPAPI_MARKER = Buffer.from('DPAPI', 'latin1');

// DPAPI-unprotect (CurrentUser scope) via PowerShell, returning raw decrypted
// bytes. Bytes are passed/returned as base64 to avoid any text-encoding loss,
// since the decrypted master key is arbitrary binary, not text.
function dpapiUnprotect(buf) {
  const psScript = [
    'Add-Type -AssemblyName System.Security',
    `$bytes = [System.Convert]::FromBase64String("${buf.toString('base64')}")`,
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([System.Convert]::ToBase64String($plain))',
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return Buffer.from(out.trim(), 'base64');
}

function getOsCryptMasterKey() {
  const raw = fs.readFileSync(LOCAL_STATE_PATH, 'utf8');
  const state = JSON.parse(raw);
  const encB64 = (state.os_crypt && state.os_crypt.encrypted_key) || state.encrypted_key;
  if (!encB64 || typeof encB64 !== 'string') return null;

  let blob = Buffer.from(encB64, 'base64');
  if (blob.subarray(0, 5).equals(DPAPI_MARKER)) blob = blob.subarray(5);
  return dpapiUnprotect(blob); // raw AES-256 key bytes
}

function rederiveKey() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg.encryptedKey || typeof cfg.encryptedKey !== 'string') return null;

    const masterKey = getOsCryptMasterKey();
    if (!masterKey || masterKey.length !== 32) return null;

    const encryptedBuf = Buffer.from(cfg.encryptedKey, 'hex');
    if (encryptedBuf.length <= 3 + 12 + 16) return null;

    const prefix = encryptedBuf.subarray(0, 3).toString('latin1');
    if (prefix !== 'v10' && prefix !== 'v11') return null;

    const nonce = encryptedBuf.subarray(3, 15);
    const tag = encryptedBuf.subarray(encryptedBuf.length - 16);
    const ciphertext = encryptedBuf.subarray(15, encryptedBuf.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const key = plaintext.toString('utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(key)) return key;
    return null;
  } catch (_e) {
    return null;
  }
}

module.exports = { rederiveKey };
