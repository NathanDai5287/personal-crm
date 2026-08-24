'use strict';
// lib/people-resolve.js — map a name/nickname that appears in message text to a
// tracked contact, and find which contacts a passage refers to. Built on lib/aliases
// (contact names, derived first names, hand-written aliases) PLUS the confirmed
// nicknames from lib/nicknames. Two consumers: the cast-of-characters ledger block
// (so the merge model sees WHO an A↔B conversation is about) and nickname target
// resolution (feature 2 — a nickname suggested for someone other than the subject).
const { buildIndex, resolve: aliasResolve, findMentions } = require('./aliases');
const { confirmedNicknames } = require('./nicknames');

// contacts: [{ slug, name }]. Returns { resolve(name)->slug|null, mentionsIn(text)->
// Set<slug>, nameBySlug }. resolve() is UNAMBIGUOUS-ONLY — a term claimed by more than
// one contact returns null, never a guess (lib/aliases rule 1).
const OWNER = 'nathan';
function buildResolver(contacts = []) {
  const built = buildIndex(contacts);
  // COLLISION-AWARE fold: add a term → slug, and if the term is ALREADY claimed (by a
  // name or another contact's nickname), add this slug too so it becomes ambiguous and
  // resolves to NOBODY. Never let one claimant silently win — that violated the
  // "claimed by two → nobody" rule and routed the wrong person's digest into ledgers.
  const addTerm = (key, slug) => {
    if (!key || !slug) return;
    if (!built.index.has(key)) built.index.set(key, new Set([slug]));
    else built.index.get(key).add(slug);
  };
  for (const c of contacts) {
    if (!c || !c.slug) continue;
    for (const nk of confirmedNicknames(c.slug)) addTerm(String(nk).toLowerCase().trim(), c.slug);
  }
  // The OWNER (Nathan) is the reader, not a tracked contact, but the model can target
  // a nickname at him ("Nathan | Wayne | ids"). Seed him so those resolve to the
  // 'nathan' slug (the /me store) — via addTerm, so a REAL contact who also claims
  // "nathan" makes it ambiguous rather than getting clobbered (P1 #6). Not "me": too
  // common a word to scan for. nameBySlug gains him so digests/labels can name him.
  addTerm(OWNER, OWNER);
  for (const nk of confirmedNicknames(OWNER)) addTerm(String(nk).toLowerCase().trim(), OWNER);
  const resolve = (name) => { const r = aliasResolve(name, built); return r && r.slug ? r.slug : null; };
  const mentionsIn = (text) => {
    const out = new Set();
    for (const m of findMentions(text, built)) if (m.slug) out.add(m.slug);
    return out;
  };
  const nameBySlug = new Map(contacts.map((c) => [c.slug, c.name]));
  if (!nameBySlug.has(OWNER)) nameBySlug.set(OWNER, 'Nathan');
  return { resolve, mentionsIn, nameBySlug, built };
}

module.exports = { buildResolver };
