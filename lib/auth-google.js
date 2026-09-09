'use strict';
// lib/auth-google.js — Google Sign-In via OAuth 2.0 authorization-code flow.
// Dependency-free: Node's global fetch + crypto. No JWT library.
//
// TRUST MODEL. We do NOT re-verify the id_token's RS256 signature locally. The
// id_token is read straight out of the token-endpoint response, which we obtain
// over TLS from https://oauth2.googleapis.com/token, authenticated with our
// client_secret. Provenance is therefore the authenticated TLS channel to
// Google, exactly as Google's own docs permit for the code flow — a locally
// forged token can never reach this path. We still validate the claims
// (aud/iss/exp/nonce/email_verified) as defense in depth.
const crypto = require('crypto');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const VALID_ISS = new Set(['https://accounts.google.com', 'accounts.google.com']);

// PKCE pair: a random verifier and its S256 challenge.
function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// A random opaque value for the `state` (login-CSRF) and `nonce` (replay) params.
function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Build the Google authorization URL to redirect the browser to.
function authUrl({ clientId, redirectUri, state, nonce, codeChallenge }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    access_type: 'online',
    prompt: 'select_account',
  });
  if (codeChallenge) {
    p.set('code_challenge', codeChallenge);
    p.set('code_challenge_method', 'S256');
  }
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

// Decode a JWT's payload segment (no signature check — see TRUST MODEL above).
function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

// Exchange an authorization code for tokens; return the decoded id_token claims.
async function exchangeCode({ code, clientId, clientSecret, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    // Fail fast instead of tying up the callback handler on a stalled TLS response
    // (undici's default timeout is ~5 min). The catch in authCallback handles it.
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`token exchange failed: ${resp.status} ${t.slice(0, 200)}`);
  }
  const tok = await resp.json();
  if (!tok.id_token) throw new Error('no id_token in token response');
  return decodeJwtPayload(tok.id_token);
}

// Validate the id_token claims. Returns true only for a well-formed, unexpired
// token minted for THIS client with a verified email (and matching nonce, when
// one was issued). `nowSec` is injectable for tests.
function validateClaims(claims, { clientId, nonce, nowSec = Date.now() / 1000 } = {}) {
  if (!claims || typeof claims !== 'object') return false;
  if (claims.aud !== clientId) return false;
  if (!VALID_ISS.has(claims.iss)) return false;
  if (typeof claims.exp !== 'number' || nowSec > claims.exp) return false;
  if (nonce != null && claims.nonce !== nonce) return false;
  if (claims.email_verified !== true && claims.email_verified !== 'true') return false;
  if (!claims.email) return false;
  return true;
}

module.exports = {
  AUTH_ENDPOINT, TOKEN_ENDPOINT,
  pkce, randomToken, authUrl, decodeJwtPayload, exchangeCode, validateClaims,
};
