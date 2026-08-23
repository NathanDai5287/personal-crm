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
function buildResolver(contacts = []) {
  const built = buildIndex(contacts);
  // Fold confirmed nicknames in as extra terms, but only when the term is unclaimed —
  // a nickname must never silently override a real name, and a collision stays with
  // whatever already holds it (i.e. ambiguous → resolves to nothing).
  for (const c of contacts) {
    if (!c || !c.slug) continue;
    for (const nk of confirmedNicknames(c.slug)) {
      const key = String(nk).toLowerCase().trim();
      if (key && !built.index.has(key)) built.index.set(key, new Set([c.slug]));
    }
  }
  const resolve = (name) => { const r = aliasResolve(name, built); return r && r.slug ? r.slug : null; };
  const mentionsIn = (text) => {
    const out = new Set();
    for (const m of findMentions(text, built)) if (m.slug) out.add(m.slug);
    return out;
  };
  return { resolve, mentionsIn, nameBySlug: new Map(contacts.map((c) => [c.slug, c.name])), built };
}

module.exports = { buildResolver };
