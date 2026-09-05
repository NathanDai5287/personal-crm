'use strict';
// lib/merge-hold.js — per-contact "parked after repeated deterministic merge failures".
//
// WHY. When a merge chunk fails for a NON-content reason that keeps recurring — the classic
// case is a structured reply the model malforms the same way every run (a bad or
// out-of-chunk source_message_id, which lib/structured-person.js throws on) — the frontier
// never advances, so crm-daily re-plans the same chunk, pays for the full merge, and fails
// again on the NEXT run too. Unbounded cost, forever, silently.
//
// This is the non-content sibling of lib/censor-hold.js. It differs in one way: a content
// rejection is parked IMMEDIATELY (Nathan must choose the masking), but a structured/commit
// failure might be a transient model wobble, so we retry up to MAX_FAILS consecutive times
// and only THEN park the contact. crm-daily skips a parked contact (its frontier stays put —
// nothing is lost) until it is released (a fixed model, or a manual release). A successful
// merge for the contact clears the counter.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { writeJsonAtomic } = require('./atomic-write');
const { fmtLocal } = require('./weeks');

const FILE = path.join(DATA_DIR, 'merge-holds.json');
const MAX_FAILS = 3; // consecutive deterministic failures on a contact before it is parked

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function save(o) { writeJsonAtomic(FILE, o); }

function isHeld(slug) { const s = load()[slug]; return Boolean(s && s.held); }

// Every currently-parked contact, with why.
function held() {
  const o = load();
  return Object.keys(o).filter((s) => o[s] && o[s].held).map((s) => ({ slug: s, ...o[s] }));
}

// Record one failed merge attempt. After MAX_FAILS consecutive failures the contact is
// PARKED (held). Returns { held, fails }.
function recordFailure(slug, error, chunkLabel, nowMs = Date.now()) {
  if (!slug) return { held: false, fails: 0 };
  const o = load();
  const prev = o[slug] || { fails: 0 };
  const fails = (prev.fails || 0) + 1;
  const held = fails >= MAX_FAILS;
  o[slug] = {
    fails,
    held,
    lastError: String(error || '').replace(/\s+/g, ' ').slice(0, 300),
    chunkLabel: chunkLabel || null,
    since: prev.since || fmtLocal(nowMs),
    updated: fmtLocal(nowMs),
  };
  save(o);
  return { held, fails };
}

// Clear a contact's failure state — call after a successful merge, or to release manually.
function clear(slug) {
  const o = load();
  if (o[slug]) { delete o[slug]; save(o); return true; }
  return false;
}

module.exports = { FILE, MAX_FAILS, isHeld, held, recordFailure, clear, release: clear };
