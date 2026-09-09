'use strict';
// lib/identity.js — turn a verified session (an email) into a role + data scope.
//
//   admin  -> the app owner (ADMIN_EMAIL). Full, unscoped access.
//   guest  -> a Google account whose email UNIQUELY matches one tracked contact's
//             `email`. Sees only that contact's page and the conversations they
//             were in (their resolveSources set).
//   none   -> no session, no unique match, or an ambiguous match. Sees nothing.
//
// Email is the identity key: unique per person (Nathan's guarantee). Zero matches
// or (defensively) more than one -> `none`, never a guess.
const PERSON = require('./person');
const { resolveSources } = require('./sources');
const { normalizeEmail } = require('./schema');
const { MY_SERVICE_ID, BOT_SERVICE_ID } = require('./config');

// A Signal serviceId is a UUID. Reject anything that isn't — and never let a
// contact whose signalId is (corrupted to) Nathan's own id or the old bot's id
// build a scope: resolveSources would then match every group they are in,
// exploding a guest's scope. Fail closed instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeContactServiceId(sid) {
  if (!sid || !UUID_RE.test(sid)) return false;
  if (sid === MY_SERVICE_ID || sid === BOT_SERVICE_ID) return false;
  return true;
}

// Case-insensitive full-address equality. normalizeEmail lowercases only the
// domain (local parts are technically case-sensitive), but every IdP in scope
// (Google) issues case-folded mailboxes, so an admin/guest match must not hinge
// on local-part case — otherwise a canonical "Foo@x" claim misses a stored "foo@x".
function sameEmail(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// The unique tracked contact whose current email matches, or null (no match) or
// the string 'ambiguous' (>1 match — should never happen if emails are unique).
function contactByEmail(cdb, email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  const matches = [];
  for (const p of PERSON.allPeople({ cdb })) {
    const e = p.email ? normalizeEmail(p.email) : null;
    if (sameEmail(e, target)) matches.push(p);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous';
  return { slug: matches[0].slug, signalId: matches[0].signalId };
}

// resolveIdentity(session, deps) -> { role, ... }.
//   session : the verified cookie payload ({ email }) or null.
//   deps    : { cdb, sdb, adminEmail } — open crm.db + Signal DB handles + the
//             admin address. sdb is only touched for a guest (to build the scope).
function resolveIdentity(session, { cdb, sdb, adminEmail }) {
  if (!session || !session.email) return { role: 'none', reason: 'no-session' };
  const email = normalizeEmail(session.email);
  if (!email) return { role: 'none', reason: 'no-email' };
  if (sameEmail(email, normalizeEmail(adminEmail))) return { role: 'admin', email };

  const hit = contactByEmail(cdb, email);
  if (hit === null) return { role: 'none', email, reason: 'no-match' };
  if (hit === 'ambiguous') return { role: 'none', email, reason: 'ambiguous-email' };
  if (!hit.signalId) return { role: 'none', email, reason: 'no-signal-id' };
  // The matched contact's signalId becomes a data scope — validate it before it can.
  if (!safeContactServiceId(hit.signalId)) return { role: 'none', email, reason: 'bad-signal-id' };

  const sources = resolveSources(sdb, hit.signalId);
  const convIds = new Set([
    ...sources.dmConvIds,
    ...sources.biGroupConvIds,
    ...sources.multiGroupConvIds,
  ]);
  return { role: 'guest', email, slug: hit.slug, convIds };
}

module.exports = { resolveIdentity, contactByEmail, safeContactServiceId, sameEmail };
