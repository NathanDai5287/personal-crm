'use strict';
// lib/lens.js — the data-access capability that makes per-guest isolation
// STRUCTURAL rather than a scattered check.
//
// Every message / message-range / attachment a request may read is gated through
// a lens:
//   * adminLens()  — unrestricted; sees everything, exactly as the app always has.
//   * guestLens(convIds) — sees ONLY rows whose conv_id is in `convIds`, the set
//     produced by lib/sources.resolveSources for that guest (their DMs + every
//     group they are a member of). This is the SAME set the pipeline uses to
//     decide what belongs in that contact's ledger, so "what a guest may see" is
//     not a new rule invented here — it is the contact's own message universe.
//
// The guarantee holds by construction: a guest branch that only ever holds a
// guestLens cannot name an out-of-scope row, because the check is baked into the
// accessor, not the call site. For /m/<id> and /m/<a>-<b> the surrounding context
// is already queried as `conv_id = anchor.conv_id` by the renderers, so the ONLY
// gate needed is "is the anchor's conv_id in scope" — everything else on the page
// is then in-scope automatically.
const { openCrmDb } = require('./signal-db');

function adminLens() {
  return {
    isAdmin: true,
    canSeeMessage() { return true; },
    canSeeSpan() { return true; },
    canSeeAttachment() { return true; },
  };
}

// deps.openDb is injectable for tests; defaults to the real crm.db opener.
function guestLens(convIds, deps = {}) {
  const set = convIds instanceof Set ? convIds : new Set(convIds || []);
  const open = deps.openDb || openCrmDb;

  // Is `id`'s conversation in the guest's scope? (The anchor test used by both
  // the single-message and range views.)
  const anchorInScope = (id) => {
    if (!set.size) return false;
    let cdb;
    try { cdb = open(); } catch { return false; }
    try {
      const row = cdb.prepare('SELECT conv_id FROM messages WHERE id = ?').get(id);
      return !!(row && row.conv_id != null && set.has(row.conv_id));
    } catch {
      return false;
    } finally {
      try { cdb.close(); } catch { /* already closed */ }
    }
  };

  return {
    isAdmin: false,
    convIds: set,
    canSeeMessage: (id) => anchorInScope(id),
    canSeeSpan: (start) => anchorInScope(start),
    // An attachment is visible only if some in-scope message references its hash.
    // att_hashes is a space-separated list of hex hashes (see lib/archive.js), so
    // we narrow with LIKE then confirm whole-token membership to avoid a
    // substring false match.
    canSeeAttachment: (hash) => {
      if (!set.size || !/^[0-9a-f]{16,}$/i.test(hash)) return false;
      let cdb;
      try { cdb = open(); } catch { return false; }
      try {
        const rows = cdb.prepare('SELECT conv_id, att_hashes FROM messages WHERE att_hashes LIKE ?')
          .all(`%${hash}%`);
        return rows.some((r) => r.conv_id != null && set.has(r.conv_id)
          && String(r.att_hashes || '').split(/\s+/).includes(hash));
      } catch {
        return false;
      } finally {
        try { cdb.close(); } catch { /* already closed */ }
      }
    },
  };
}

module.exports = { adminLens, guestLens };
