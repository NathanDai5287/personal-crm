'use strict';
// lib/aliases.js — resolve the names people actually type to CRM contacts.
//
// This is a different job from the `name`/`slug` fields already in
// crm-nicknames.json. Those answer "what should the CRM CALL this person"
// (1:1, a display override). Aliases answer "which strings in message text
// REFER to this person" (1:many, a lookup index).
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
//    needs no configuration, but anything hand-written in the JSON wins, and a
//    hand-written alias can rescue a name the derivation made ambiguous.

const fs = require('fs');
const { NICKNAMES } = require('./config');

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const norm = (s) => String(s).toLowerCase().trim().replace(/\s+/g, ' ');

// Read the override file. Supports both keying schemes:
//   byServiceId — for people you have a Signal thread with (has a serviceId)
//   bySlug      — for people who are only ever MENTIONED and have no thread,
//                 which the serviceId-keyed shape cannot represent at all.
function loadAliasFile(file = NICKNAMES) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* absent is fine */ }
  const entries = [];
  for (const [serviceId, v] of Object.entries(raw.byServiceId || {})) {
    if (!v || typeof v !== 'object') continue;
    entries.push({
      serviceId,
      name: v.name || null,
      slug: v.slug || (v.name ? slugify(v.name) : null),
      aliases: Array.isArray(v.aliases) ? v.aliases : [],
    });
  }
  for (const [slug, v] of Object.entries(raw.bySlug || {})) {
    if (!v || typeof v !== 'object') continue;
    entries.push({
      serviceId: null,
      name: v.name || null,
      slug,
      aliases: Array.isArray(v.aliases) ? v.aliases : [],
    });
  }
  return entries.filter((e) => e.slug);
}

// contacts: [{ slug, name }] — normally every row in crm.db's contacts table, so
// derived first names cover people who have no override entry.
function buildIndex(contacts = [], file = NICKNAMES) {
  const overrides = loadAliasFile(file);
  const bySlug = new Map();

  const upsert = (slug, name) => {
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, name: name || null, aliases: new Set(), derived: new Set() });
    const rec = bySlug.get(slug);
    if (name && !rec.name) rec.name = name;
    return rec;
  };

  for (const c of contacts) if (c && c.slug) upsert(c.slug, c.name);
  for (const o of overrides) {
    const rec = upsert(o.slug, o.name);
    for (const a of o.aliases) if (String(a).trim()) rec.aliases.add(norm(a));
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

module.exports = { buildIndex, resolve, findMentions, loadAliasFile, slugify };
