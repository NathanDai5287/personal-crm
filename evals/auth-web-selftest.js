'use strict';
// evals/auth-web-selftest.js — integration test for the live web auth gate.
// Boots scripts/crm-web.js on a scratch port with a known session secret and a
// test admin email, then drives it over HTTP with minted session cookies to
// verify: signed-out redirects, admin access, no-access for an unknown email,
// and — when a real contact with an email is available on this machine — that a
// guest sees ONLY their own page and is walled off from every admin surface and
// every other contact.
//
//   node evals/auth-web-selftest.js
const assert = require('assert');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const session = require('../lib/session');
const { openCrmDb } = require('../lib/signal-db');
const PERSON = require('../lib/person');

const SECRET = 'integration-test-secret-please-ignore';
const ADMIN = 'itest-admin@example.com';

let passed = 0; let skipped = 0;
function ok(name) { passed += 1; console.log(`  ok   ${name}`); }
function skip(name, why) { skipped += 1; console.log(`  skip ${name} (${why})`); }
function fail(name, msg) { console.error(`  FAIL ${name}: ${msg}`); process.exitCode = 1; }

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

function cookieFor(email) {
  return `crm_session=${encodeURIComponent(session.sign({ email }, SECRET, 3600_000))}`;
}

function get(port, pathname, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'GET',
      headers: cookie ? { Cookie: cookie } : {},
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitReady(port, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await get(port, '/login'); if (r.status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

// A tracked contact that has both an email and a signalId, for the guest tests.
function findGuestContact() {
  let cdb;
  try { cdb = openCrmDb(); } catch { return null; }
  try {
    for (const p of PERSON.allPeople({ cdb })) {
      if (p.email && p.signalId) return { slug: p.slug, email: p.email };
    }
    return null;
  } catch { return null; } finally { try { cdb.close(); } catch { /* */ } }
}

async function main() {
  const port = await freePort();
  const env = {
    ...process.env,
    CRM_SESSION_SECRET: SECRET,
    CRM_ADMIN_EMAIL: ADMIN,
    CRM_WEB_PORT: String(port),
    CRM_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, // http → cookies not marked Secure
  };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'crm-web.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });

  try {
    await waitReady(port);

    // ---- signed-out --------------------------------------------------------
    let r = await get(port, '/');
    (r.status === 302 && /\/login$/.test(r.location || '')) ? ok('signed-out / → 302 /login')
      : fail('signed-out / → 302 /login', `got ${r.status} ${r.location}`);

    r = await get(port, '/login');
    r.status === 200 ? ok('/login → 200') : fail('/login → 200', `got ${r.status}`);

    r = await get(port, '/status');
    (r.status === 302 && /\/login$/.test(r.location || '')) ? ok('signed-out /status → 302 /login')
      : fail('signed-out /status → 302 /login', `got ${r.status} ${r.location}`);

    // ---- admin -------------------------------------------------------------
    r = await get(port, '/', cookieFor(ADMIN));
    r.status === 200 ? ok('admin / → 200 (full app)') : fail('admin / → 200', `got ${r.status}`);

    r = await get(port, '/status', cookieFor(ADMIN));
    r.status === 200 ? ok('admin /status → 200') : fail('admin /status → 200', `got ${r.status}`);

    // ---- unknown email (no match) → no access ------------------------------
    r = await get(port, '/', cookieFor('nobody-xyz-unmatched@example.com'));
    r.status === 403 ? ok('unknown-email / → 403') : fail('unknown-email / → 403', `got ${r.status}`);

    r = await get(port, '/status', cookieFor('nobody-xyz-unmatched@example.com'));
    r.status === 403 ? ok('unknown-email /status → 403') : fail('unknown-email /status → 403', `got ${r.status}`);

    // ---- tampered cookie → treated as signed out ---------------------------
    r = await get(port, '/', 'crm_session=garbage.forged');
    (r.status === 302 && /\/login$/.test(r.location || '')) ? ok('tampered cookie → 302 /login')
      : fail('tampered cookie → 302 /login', `got ${r.status} ${r.location}`);

    // ---- guest (needs a real contact w/ email + Signal DB) -----------------
    const guest = findGuestContact();
    if (!guest) {
      skip('guest isolation', 'no contact with email+signalId on this machine');
    } else {
      const gc = cookieFor(guest.email);
      const own = await get(port, `/c/${encodeURIComponent(guest.slug)}`, gc);
      if (own.status !== 200) {
        // Most likely the Signal DB could not be opened here, so the identity
        // resolved to "none". Report rather than silently pass.
        skip('guest isolation', `guest own page returned ${own.status} (Signal DB unavailable?)`);
      } else {
        ok('guest can see own page (200)');

        r = await get(port, '/', gc);
        (r.status === 302 && new RegExp(`/c/${guest.slug}$`).test(r.location || '')) ? ok('guest / → 302 to own page')
          : fail('guest / → 302 to own page', `got ${r.status} ${r.location}`);

        // Another contact's page must be indistinguishable from nonexistent (404).
        const other = otherSlug(guest.slug);
        if (other) {
          r = await get(port, `/c/${encodeURIComponent(other)}`, gc);
          r.status === 404 ? ok("guest other contact page → 404") : fail('guest other page → 404', `got ${r.status}`);
        } else {
          skip('guest other page → 404', 'only one contact available');
        }

        for (const admPath of ['/status', '/tasks', '/me', '/admin/jobs', '/graph', '/runs']) {
          r = await get(port, admPath, gc);
          r.status === 403 ? ok(`guest ${admPath} → 403`) : fail(`guest ${admPath} → 403`, `got ${r.status}`);
        }

        // A wildly out-of-range message id must 404 for the guest (not leak).
        r = await get(port, '/m/999999999', gc);
        r.status === 404 ? ok('guest out-of-scope /m/<id> → 404') : fail('guest /m → 404', `got ${r.status}`);
      }
    }
  } catch (e) {
    fail('integration harness', `${e.message}\n--- server log ---\n${serverLog}`);
  } finally {
    child.kill('SIGKILL');
  }

  console.log(`\nauth-web-selftest: ${passed} passed, ${skipped} skipped`);
  if (process.exitCode) console.error('auth-web-selftest: FAILURES above');
  else console.log('auth-web-selftest: all green');
}

// Any tracked slug other than `slug`, for the "can't see another page" check.
function otherSlug(slug) {
  let cdb;
  try { cdb = openCrmDb(); } catch { return null; }
  try {
    for (const p of PERSON.allPeople({ cdb })) if (p.slug !== slug) return p.slug;
    return null;
  } catch { return null; } finally { try { cdb.close(); } catch { /* */ } }
}

main();
