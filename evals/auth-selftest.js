'use strict';
// evals/auth-selftest.js — unit tests for the web auth stack: signed sessions
// (lib/session), the Google OAuth helpers (lib/auth-google), and the per-guest
// data lens (lib/lens). Pure: no network, no DB, no server. Run:
//   node evals/auth-selftest.js
const assert = require('assert');
const crypto = require('crypto');

const session = require('../lib/session');
const AUTHG = require('../lib/auth-google');
const { adminLens, guestLens } = require('../lib/lens');
const { safeContactServiceId, sameEmail } = require('../lib/identity');
const { MY_SERVICE_ID, BOT_SERVICE_ID } = require('../lib/config');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

// ---- lib/session ------------------------------------------------------------
const SECRET = 'test-secret-abc';

test('session round-trips a payload', () => {
  const tok = session.sign({ email: 'a@b.com' }, SECRET, 60_000);
  const out = session.verify(tok, SECRET);
  assert.strictEqual(out.email, 'a@b.com');
  assert.ok(out.exp > Date.now());
});

test('session rejects a tampered payload', () => {
  const tok = session.sign({ email: 'a@b.com' }, SECRET, 60_000);
  const [data, mac] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ email: 'evil@b.com', exp: Date.now() + 60_000 }), 'utf8').toString('base64url');
  assert.strictEqual(session.verify(`${forged}.${mac}`, SECRET), null);
  // also: the original data with a garbage mac
  assert.strictEqual(session.verify(`${data}.deadbeef`, SECRET), null);
});

test('session rejects a wrong secret', () => {
  const tok = session.sign({ email: 'a@b.com' }, SECRET, 60_000);
  assert.strictEqual(session.verify(tok, 'other-secret'), null);
});

test('session rejects an expired token', () => {
  const tok = session.sign({ email: 'a@b.com' }, SECRET, -1);
  assert.strictEqual(session.verify(tok, SECRET), null);
});

test('session rejects junk', () => {
  assert.strictEqual(session.verify('', SECRET), null);
  assert.strictEqual(session.verify('noneatall', SECRET), null);
  assert.strictEqual(session.verify(null, SECRET), null);
});

test('cookie parse + serialize', () => {
  const c = session.parseCookies('a=1; crm_session=xyz%2Fabc; b=2');
  assert.strictEqual(c.crm_session, 'xyz/abc');
  const s = session.serializeCookie('crm_session', 'v/v', { maxAgeMs: 1000, secure: true });
  assert.ok(/crm_session=v%2Fv/.test(s));
  assert.ok(/HttpOnly/.test(s));
  assert.ok(/Secure/.test(s));
  assert.ok(/SameSite=Lax/.test(s));
  assert.ok(/Max-Age=1/.test(s));
  const cleared = session.serializeCookie('crm_session', '', { maxAgeMs: 0 });
  assert.ok(/Max-Age=0/.test(cleared));
  assert.ok(!/Secure/.test(cleared)); // secure omitted when not requested
});

// ---- lib/auth-google --------------------------------------------------------
test('authUrl carries the expected params', () => {
  const u = new URL(AUTHG.authUrl({
    clientId: 'CID', redirectUri: 'https://x/cb', state: 'ST', nonce: 'NO', codeChallenge: 'CH',
  }));
  assert.strictEqual(u.searchParams.get('client_id'), 'CID');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://x/cb');
  assert.strictEqual(u.searchParams.get('response_type'), 'code');
  assert.strictEqual(u.searchParams.get('scope'), 'openid email profile');
  assert.strictEqual(u.searchParams.get('state'), 'ST');
  assert.strictEqual(u.searchParams.get('nonce'), 'NO');
  assert.strictEqual(u.searchParams.get('code_challenge'), 'CH');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
});

test('pkce challenge is the S256 of the verifier', () => {
  const { verifier, challenge } = AUTHG.pkce();
  const expect = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.strictEqual(challenge, expect);
});

// Build a fake unsigned JWT (header.payload.sig) — decode reads the payload only.
function fakeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.SIGNATURE`;
}

test('decodeJwtPayload extracts claims', () => {
  const claims = AUTHG.decodeJwtPayload(fakeJwt({ email: 'z@z.com', aud: 'CID' }));
  assert.strictEqual(claims.email, 'z@z.com');
  assert.strictEqual(claims.aud, 'CID');
  assert.throws(() => AUTHG.decodeJwtPayload('not-a-jwt'));
});

test('validateClaims accepts a good token and rejects bad ones', () => {
  const base = {
    aud: 'CID', iss: 'https://accounts.google.com',
    exp: Math.floor(Date.now() / 1000) + 3600, email: 'g@g.com', email_verified: true, nonce: 'N',
  };
  const opt = { clientId: 'CID', nonce: 'N' };
  assert.strictEqual(AUTHG.validateClaims(base, opt), true);
  assert.strictEqual(AUTHG.validateClaims({ ...base, aud: 'OTHER' }, opt), false, 'wrong aud');
  assert.strictEqual(AUTHG.validateClaims({ ...base, iss: 'https://evil.com' }, opt), false, 'wrong iss');
  assert.strictEqual(AUTHG.validateClaims({ ...base, exp: Math.floor(Date.now() / 1000) - 10 }, opt), false, 'expired');
  assert.strictEqual(AUTHG.validateClaims({ ...base, nonce: 'WRONG' }, opt), false, 'nonce mismatch');
  assert.strictEqual(AUTHG.validateClaims({ ...base, email_verified: false }, opt), false, 'unverified email');
  assert.strictEqual(AUTHG.validateClaims({ ...base, email: '' }, opt), false, 'no email');
  assert.strictEqual(AUTHG.validateClaims(null, opt), false, 'null');
});

// ---- lib/lens ---------------------------------------------------------------
// A fake crm.db: messages with {id, conv_id, att_hashes}. Implements just the two
// query shapes the lens uses.
function fakeDb(messages) {
  return {
    prepare(sql) {
      if (/WHERE id = \?/.test(sql)) {
        return { get: (id) => messages.find((m) => m.id === id) };
      }
      if (/att_hashes LIKE \?/.test(sql)) {
        return {
          all: (pat) => {
            const needle = String(pat).replace(/%/g, '');
            return messages.filter((m) => String(m.att_hashes || '').includes(needle));
          },
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    close() {},
  };
}

const HASH_IN = 'a'.repeat(32);
const HASH_OUT = 'b'.repeat(32);
const MESSAGES = [
  { id: 10, conv_id: 'convA', att_hashes: `${HASH_IN} cccc` }, // in scope
  { id: 20, conv_id: 'convB', att_hashes: HASH_OUT },          // out of scope
  { id: 30, conv_id: 'convA', att_hashes: null },              // in scope, no attachment
];

test('adminLens sees everything', () => {
  const L = adminLens();
  assert.strictEqual(L.canSeeMessage(20), true);
  assert.strictEqual(L.canSeeSpan(20), true);
  assert.strictEqual(L.canSeeAttachment(HASH_OUT), true);
});

test('guestLens gates by conv scope', () => {
  const L = guestLens(new Set(['convA']), { openDb: () => fakeDb(MESSAGES) });
  assert.strictEqual(L.canSeeMessage(10), true, 'in-scope message');
  assert.strictEqual(L.canSeeMessage(30), true, 'in-scope message (no att)');
  assert.strictEqual(L.canSeeMessage(20), false, 'out-of-scope message');
  assert.strictEqual(L.canSeeMessage(999), false, 'nonexistent message');
  assert.strictEqual(L.canSeeSpan(10), true, 'in-scope anchor');
  assert.strictEqual(L.canSeeSpan(20), false, 'out-of-scope anchor');
});

test('guestLens gates attachments by owning message scope', () => {
  const L = guestLens(new Set(['convA']), { openDb: () => fakeDb(MESSAGES) });
  assert.strictEqual(L.canSeeAttachment(HASH_IN), true, 'attachment on in-scope message');
  assert.strictEqual(L.canSeeAttachment(HASH_OUT), false, 'attachment on out-of-scope message');
  assert.strictEqual(L.canSeeAttachment('deadbeefdeadbeef'), false, 'unknown hash');
  assert.strictEqual(L.canSeeAttachment('nothex'), false, 'malformed hash');
});

test('an empty scope sees nothing', () => {
  const L = guestLens(new Set(), { openDb: () => fakeDb(MESSAGES) });
  assert.strictEqual(L.canSeeMessage(10), false);
  assert.strictEqual(L.canSeeAttachment(HASH_IN), false);
});

test('guestLens rejects a substring-only hash match (whole-token check)', () => {
  // HASH_IN is a 32-char run of "a"; a shorter all-"a" needle is a substring of
  // the stored token but is NOT a whole token, so it must not match.
  const L = guestLens(new Set(['convA']), { openDb: () => fakeDb(MESSAGES) });
  assert.strictEqual(L.canSeeAttachment('a'.repeat(16)), false);
});

// ---- lib/identity hardening -------------------------------------------------
test('safeContactServiceId requires a UUID and rejects Nathan/bot ids', () => {
  assert.strictEqual(safeContactServiceId('41b0d08a-b762-4aae-a14e-c6d28bba4b47'), true, 'valid uuid');
  assert.strictEqual(safeContactServiceId(MY_SERVICE_ID), false, "Nathan's own id");
  assert.strictEqual(safeContactServiceId(BOT_SERVICE_ID), false, 'old bot id');
  assert.strictEqual(safeContactServiceId('not-a-uuid'), false, 'non-uuid');
  assert.strictEqual(safeContactServiceId(''), false, 'empty');
  assert.strictEqual(safeContactServiceId(null), false, 'null');
});

test('sameEmail is case-insensitive on the full address', () => {
  assert.strictEqual(sameEmail('Foo@Bar.com', 'foo@bar.com'), true);
  assert.strictEqual(sameEmail('NathanDai2000@gmail.com', 'nathandai2000@gmail.com'), true);
  assert.strictEqual(sameEmail('a@b.com', 'a@c.com'), false);
  assert.strictEqual(sameEmail(null, 'a@b.com'), false);
  assert.strictEqual(sameEmail('a@b.com', null), false);
});

console.log(`\nauth-selftest: ${passed} passed`);
if (process.exitCode) console.error('auth-selftest: FAILURES above'); else console.log('auth-selftest: all green');
