'use strict';
// lib/person.js — the Person accessor.
//
// WHY THIS EXISTS. "A person" — a name, their nicknames, phone, birthday, Signal id,
// relationship — had no definition in code. That knowledge is real but scattered: the
// profile markdown header, the nicknames store (crm.db), and the archive. Every caller
// re-derived it ad hoc. This assembles it in ONE place so a Person is a value the app can
// pass around. Read-only; it changes no storage.
//
// This is PHASE 0 of the structured-person refactor (see docs/ENGINEERING-LOG and the
// still-unwired lib/schema.js): the accessor comes first and reads from where the data
// lives today; later phases move the store of record into the `facts` table and this
// accessor reads from there instead, without its callers changing.
//
// SOURCES today:
//   contacts/<slug>.md header  → name, signalId, phone, relationship, birthday, first/last
//   lib/nicknames (crm.db)     → confirmed nicknames
//   crm.db messages (optional) → live last-contact + message count, when a handle is passed
const fs = require('fs');
const path = require('path');
const { CONTACTS_DIR } = require('./config');
const { dateKey } = require('./weeks');

function profilePath(slug) { return path.join(CONTACTS_DIR, `${slug}.md`); }
function exists(slug) { try { return fs.existsSync(profilePath(slug)); } catch { return false; } }

// Parse the `- **Key:** value` metadata block at the top of a profile (stops at the first
// `##`). Mirrors crm-web's parseMeta: keys lowercased, `_*` markup stripped — so a
// placeholder like `_unknown_` becomes `unknown`, which `real()` then treats as absent.
function parseHeader(md) {
  const meta = {};
  const re = /^-\s+\*\*([^:*]+):\*\*\s*(.+)$/;
  for (const line of String(md).split(/\r?\n/)) {
    if (line.startsWith('## ')) break;
    const m = line.trim().match(re);
    if (m) meta[m[1].trim().toLowerCase()] = m[2].replace(/[_*]/g, '').trim();
  }
  return meta;
}

// A header placeholder ('unknown', 'TBD', '(unknown)', 'n/a', '') is not a real value → null.
// Strips one layer of surrounding ()/[] first, since the merge sometimes writes "(unknown)".
function real(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const bare = s.replace(/^[([]\s*|\s*[)\]]$/g, '').trim();
  return /^(unknown|tbd|n\/?a|none|not set|not provided|unset)$/i.test(bare) ? null : s;
}

// Confirmed nicknames for a slug (best-effort — the store is optional).
function confirmedNicks(slug) {
  try {
    const N = require('./nicknames');
    return (N.confirmedNicknames(slug) || []).filter(Boolean);
  } catch { return []; }
}

// getPerson(slug, opts?) → a Person object, or null when there is no profile for the slug.
//   opts.cdb — an open crm.db handle. When given, lastContact + messageCount come from the
//   LIVE archive (authoritative) rather than the profile header's snapshot.
function getPerson(slug, opts = {}) {
  let md;
  try { md = fs.readFileSync(profilePath(slug), 'utf8'); } catch { return null; }
  const h = parseHeader(md);
  const titleLine = md.split(/\r?\n/).find((l) => l.startsWith('# '));
  const name = titleLine ? titleLine.slice(2).trim() : slug;

  let lastContact = real(h['last contact']);
  let messageCount = null;
  if (opts.cdb) {
    try {
      const r = opts.cdb.prepare('SELECT COUNT(*) n, MAX(sent_at) mx FROM messages WHERE contact_slug = ?').get(slug);
      messageCount = r ? r.n : null;
      if (r && r.mx) lastContact = dateKey(r.mx); // Pacific, like the rest of the app
    } catch { /* keep the header snapshot */ }
  }

  return {
    slug,
    name,
    nicknames: confirmedNicks(slug),
    signalId: real(h['signal id']),
    phone: real(h['phone']),
    relationship: real(h['relationship']),
    birthday: real(h['birthday']),
    firstContact: real(h['first contact']),
    lastContact,
    messageCount,
  };
}

// Every tracked person (one per contacts/<slug>.md), name-sorted. Pass opts.cdb through
// for live last-contact/counts.
function allPeople(opts = {}) {
  let files = [];
  try { files = fs.readdirSync(CONTACTS_DIR).filter((f) => f.endsWith('.md')); } catch { return []; }
  return files
    .map((f) => getPerson(f.replace(/\.md$/, ''), opts))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { getPerson, allPeople, parseHeader, profilePath, exists };
