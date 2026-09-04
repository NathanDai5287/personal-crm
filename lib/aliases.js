'use strict';
// lib/aliases.js — resolve the names people actually type to CRM contacts.
//
// Aliases answer "which strings in message text REFER to this person" (1:many, a
// lookup index) — a different job from what a person is CALLED (that is the Signal
// nickname, resolved in lib/signal-names). The explicit aliases now come from the
// confirmed-nickname store (lib/nicknames), passed in by lib/people-resolve; there
// is no longer a separate crm-display-names.json. A hand-added nickname like "abhi"
// is exactly such an alias.
//
// THREE RULES, each learned from this corpus:
//
// 1. AMBIGUOUS RESOLVES TO NOTHING. There are three Maxes (Max Wang, Max Tao,
//    Max Liang). Silently picking one is worse than not resolving — a wrong
//    cross-reference is a fact the profile now asserts falsely, and nothing
//    downstream can tell it was a guess. Ambiguity is a first-class result.
//
// 2. ALIASES ARE AN INDEX, NEVER A TRANSFORM. Nothing here rewrites message
//    text. The archive is the only source of truth for re-merging, and
//    substituting "Abhiram" for "abhi" in it would corrupt the record to make a
//    display nicety. Resolution happens at read time, on a copy.
//
// 3. EXPLICIT BEATS DERIVED. First names are auto-derived so the common case
//    needs no configuration, but a confirmed nickname wins, and one can rescue a
//    name the derivation made ambiguous (name one Max "max" and the others clear).

const norm = (s) => String(s).toLowerCase().trim().replace(/\s+/g, ' ');

// contacts: [{ slug, name }] — normally every row in crm.db's contacts table, so
// derived first names cover people who have no explicit alias.
// aliasesBySlug: slug -> [alias strings] (confirmed nicknames), the explicit layer.
function buildIndex(contacts = [], aliasesBySlug = new Map()) {
  const bySlug = new Map();

  const upsert = (slug, name) => {
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, name: name || null, aliases: new Set(), derived: new Set() });
    const rec = bySlug.get(slug);
    if (name && !rec.name) rec.name = name;
    return rec;
  };

  for (const c of contacts) if (c && c.slug) upsert(c.slug, c.name);
  const aliasEntries = aliasesBySlug instanceof Map ? aliasesBySlug.entries() : Object.entries(aliasesBySlug);
  for (const [slug, aliases] of aliasEntries) {
    const rec = upsert(slug, null);
    for (const a of aliases || []) if (String(a).trim()) rec.aliases.add(norm(a));
  }

  // Derive: full name, and first name alone. Derived entries are what create
  // most collisions, which is exactly why rule 1 exists.
  for (const rec of bySlug.values()) {
    if (!rec.name) continue;
    rec.derived.add(norm(rec.name));
    const first = norm(rec.name).split(' ')[0];
    if (first && first.length > 1) rec.derived.add(first);
  }

  // alias -> slugs. Explicit and derived share one namespace, but explicit wins:
  // if a term is claimed explicitly by exactly one contact, derived claims on
  // that same term are discarded rather than making it ambiguous. That is the
  // escape hatch for "max" — naming one Max explicitly disambiguates the rest.
  const explicit = new Map();
  const derived = new Map();
  const add = (m, k, slug) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(slug); };
  for (const rec of bySlug.values()) {
    for (const a of rec.aliases) add(explicit, a, rec.slug);
    for (const a of rec.derived) add(derived, a, rec.slug);
  }
  const index = new Map();
  for (const [k, slugs] of derived) index.set(k, new Set(slugs));
  for (const [k, slugs] of explicit) {
    if (slugs.size === 1) index.set(k, new Set(slugs));
    else { // several contacts explicitly claim it — genuinely ambiguous
      if (!index.has(k)) index.set(k, new Set());
      for (const s of slugs) index.get(k).add(s);
    }
  }
  return { index, bySlug };
}

// { slug } | { ambiguous: [slug,…] } | null. Never guesses.
function resolve(term, built) {
  const hit = built.index.get(norm(term));
  if (!hit || !hit.size) return null;
  const slugs = [...hit];
  return slugs.length === 1 ? { slug: slugs[0] } : { ambiguous: slugs.sort() };
}

// Scan text for known aliases. Longest-first so "max tao" wins over "max", and
// word-boundary matched so "abhi" does not fire inside "abhiram" twice or
// inside an unrelated word. Returns matches; changes nothing.
function findMentions(text, built) {
  const terms = [...built.index.keys()].sort((a, b) => b.length - a.length);
  const out = [];
  const claimed = [];
  const overlaps = (s, e) => claimed.some(([cs, ce]) => s < ce && e > cs);
  for (const t of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of String(text).matchAll(re)) {
      const s = m.index, e = s + m[0].length;
      if (overlaps(s, e)) continue;
      claimed.push([s, e]);
      out.push({ term: m[0], at: s, ...resolve(t, built) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

module.exports = { buildIndex, resolve, findMentions };
