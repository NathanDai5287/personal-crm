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
const { currentFacts, neighbors } = require('./schema');

const PERSON_FIELDS = {
  signal_id: 'signalId', phone: 'phone', relationship: 'relationship', birthday: 'birthday',
  first_contact: 'firstContact', last_contact: 'lastContact',
};

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

// Parse the `## Talking points` section into [{ date, sortDate, text, line }]. A month-only
// date is padded to the 1st so it sorts/compares against YYYY-MM-DD; the raw form is kept
// for display. Ends at the next heading.
function parseTalkingPoints(md) {
  const items = [];
  let inSection = false;
  const lines = String(md).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^##\s+Talking points/i.test(t)) { inSection = true; continue; }
    if (inSection && /^#/.test(t)) break;
    if (!inSection) continue;
    const m = t.match(/^[-*]\s+(?:(?:\*\*)?(\d{4}-\d{2}(?:-\d{2})?)(?:\*\*)?\s+)?(.+)$/);
    if (m && m[2]) {
      items.push({
        date: m[1] || null,
        sortDate: m[1] ? (m[1].length === 7 ? `${m[1]}-01` : m[1]) : null,
        text: m[2].trim(),
        line: i + 1,
      });
    }
  }
  return items;
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

  const person = {
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
    talkingPoints: parseTalkingPoints(md),
    facts: [],
    mentions: { outbound: [], inbound: [] },
  };
  if (opts.cdb) {
    try {
      person.facts = currentFacts(opts.cdb, slug);
      for (const f of person.facts) {
        const key = PERSON_FIELDS[f.field];
        if (key) person[key] = f.value;
      }
      person.mentions = neighbors(opts.cdb, slug);
    } catch { /* pre-schema database: keep the compatibility sources */ }
  }
  return person;
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

// slug for a contacts-table row (file_path is 'data/contacts/<slug>.md').
function slugOfPath(fp) {
  return fp ? String(fp).replace('data/contacts/', '').replace(/\.md$/, '') : null;
}

// THE tracked people, as contacts-table rows filtered to those that still have a profile
// on disk. This is the single gate: "tracked" == a profile exists (== crm-tracked.json).
// Every people-list surface should come through here, never a raw `SELECT * FROM contacts`,
// so an orphaned stub row (a backfilled contact whose profile was later deleted) can never
// leak in as a person. Returns [{ slug, name, signalId, file_path }].
function trackedContacts(cdb) {
  let rows = [];
  try { rows = cdb.prepare('SELECT file_path, name, signal_id FROM contacts').all(); } catch { return []; }
  return rows
    .map((r) => ({ slug: slugOfPath(r.file_path), name: r.name, signalId: r.signal_id, file_path: r.file_path }))
    .filter((c) => c.slug && exists(c.slug));
}

// Prune contacts-table rows whose profile is gone, so the table stays == the tracked set.
// Untracking a person is "delete their profile"; the next sweep calls this and the row
// follows. Returns the removed file_paths. Idempotent — a no-op once the table is honest.
// Safe because autopromote only ever writes a row and a profile together, so a live tracked
// person never appears here.
function reconcileContacts(cdb) {
  let rows = [];
  try { rows = cdb.prepare('SELECT file_path FROM contacts').all(); } catch { return []; }
  // FAIL-SAFE: only prune a row whose profile is DEFINITIVELY absent (ENOENT). A
  // transient stat error (permissions, I/O, a locked FS) must NEVER delete a live
  // tracked person's row — deletes here are unrecoverable (sweepContact never re-inserts).
  const orphans = rows.map((r) => r.file_path).filter((fp) => {
    const s = slugOfPath(fp);
    if (!s) return false; // malformed row (null file_path): leave it; reads already ignore it
    try { fs.accessSync(profilePath(s)); return false; } // profile present → keep
    catch (e) { return e && e.code === 'ENOENT'; }        // prune only on confirmed absence
  });
  if (!orphans.length) return [];
  const del = cdb.prepare('DELETE FROM contacts WHERE file_path = ?');
  const removed = [];
  for (const fp of orphans) { try { del.run(fp); removed.push(fp); } catch { /* skip a locked/odd row */ } }
  return removed;
}

module.exports = { getPerson, allPeople, parseHeader, profilePath, exists, trackedContacts, reconcileContacts };
