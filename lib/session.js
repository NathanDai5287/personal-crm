'use strict';
// lib/session.js — stateless, signed session cookies for the web app.
//
// A session is a small JSON payload ({ email, iat, exp }) carried in a cookie,
// authenticated by an HMAC-SHA256 tag over the encoded payload. No server-side
// store: the signature is the whole trust model, so a tampered or expired cookie
// verifies to null and the request is treated as signed-out. Rotating
// SESSION_SECRET invalidates every outstanding session at once (the only
// revocation lever, which is enough here).
const crypto = require('crypto');

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

// sign(payload, secret, maxAgeMs) -> "base64url(payload).base64url(hmac)"
function sign(payload, secret, maxAgeMs) {
  const now = Date.now();
  const body = { ...payload, iat: now, exp: now + maxAgeMs };
  const data = b64urlJson(body);
  const mac = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${mac}`;
}

// verify(token, secret) -> the payload object, or null if missing / malformed /
// tampered / expired. Constant-time tag comparison.
function verify(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const data = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
  if (!obj || typeof obj.exp !== 'number' || Date.now() > obj.exp) return null;
  return obj;
}

// Parse a Cookie header into a { name: value } map (values URL-decoded).
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* leave raw */ }
    out[k] = v;
  });
  return out;
}

// Serialize a Set-Cookie value. opts: { maxAgeMs, secure, httpOnly, sameSite, path }.
function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (typeof opts.maxAgeMs === 'number') parts.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`);
  return parts.join('; ');
}

module.exports = { sign, verify, parseCookies, serializeCookie };
