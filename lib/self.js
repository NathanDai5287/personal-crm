'use strict';
// lib/self.js — Nathan's own profile (data/contacts/nathan.md): the same pipeline as a
// contact, inverted. A contact's profile is Nathan's notes about THEM from their shared
// conversations; this one is everyone's conversations with Nathan read for what they say
// about HIM. Its own merge stream (prompts/self-merge.md) and Timeline template
// (prompts/self-compact.md), run by crm-daily after the contact merges, on its own model
// (lib/run-models 'self').
//
// SOURCES: every conversation in the archive. The sweep only archives tracked people's
// DMs and groups, so Note to Self and the old bot's DM never get in — they are still
// excluded here by conversation type, in case that ever changes.
//
// NOT A CONTACT. nathan.md lives in data/contacts/ so the profile page, the merge's
// @file paths and the memory history treat it like any other profile, but it is NOT in
// crm-tracked.json and has no contacts-table row, and lib/person.allPeople() leaves it
// out — so it never shows up as a person in the roster or graph, and never matches a
// guest's email (lib/identity). The merge frontier is the same `merged` table, keyed by
// slug 'nathan'.
const fs = require('fs');
const path = require('path');
const { CONTACTS_DIR, SELF_SLUG, MY_SERVICE_ID, BOT_SERVICE_ID } = require('./config');
const { dateKey } = require('./weeks');
const { writeFileAtomic } = require('./atomic-write');

const SELF_NAME = 'Nathan';
const selfProfilePath = () => path.posix.join(CONTACTS_DIR, `${SELF_SLUG}.md`);

// Every archived conversation the self profile reads, with the label its ledger lines
// carry: `DM: <name>` for a 1:1 thread, the group's name for a group. Ordered by convId
// (stable). `sdb` is optional: without it, labels fall back to the archive's own
// `conversation` column ('DM with X' / the group name).
function selfConversations(cdb, sdb, nameMap = new Map()) {
  const rows = cdb.prepare(
    'SELECT conv_id AS convId, MAX(conversation) AS conversation, MAX(contact_slug) AS slug FROM messages WHERE conv_id IS NOT NULL GROUP BY conv_id ORDER BY conv_id',
  ).all();
  // A DM is labelled with its TRACKED CONTACT's display name — the same one that contact's
  // own ledgers use (Signal name of the canonical id, else the contacts row). Signal's own
  // conversation row can carry an alias identity's old profile name ("Big Ritty").
  const contactName = (slug) => {
    if (!slug) return null;
    try {
      const c = cdb.prepare('SELECT name, signal_id FROM contacts WHERE file_path = ?').get(`data/contacts/${slug}.md`);
      return c ? (nameMap.get(c.signal_id) || c.name || null) : null;
    } catch { return null; }
  };
  const meta = new Map();
  if (sdb && rows.length) {
    try {
      const ph = rows.map(() => '?').join(',');
      for (const r of sdb.prepare(`SELECT id, type, name, serviceId FROM conversations WHERE id IN (${ph})`).all(rows.map((r) => r.convId))) {
        meta.set(r.id, r);
      }
    } catch { /* labels fall back to the archive column */ }
  }
  const out = [];
  for (const r of rows) {
    const m = meta.get(r.convId);
    const archived = String(r.conversation || '');
    const isDm = m ? m.type === 'private' : /^DM with /.test(archived);
    // Note to Self and the old bot's DM are not conversations with anyone.
    if (m && m.type === 'private' && (m.serviceId === MY_SERVICE_ID || m.serviceId === BOT_SERVICE_ID)) continue;
    if (/^note to self$/i.test(archived)) continue;
    let name;
    if (isDm) name = contactName(r.slug) || (m && nameMap.get(m.serviceId)) || archived.replace(/^DM with /, '') || 'unknown';
    else name = (m && m.name) || archived || 'group';
    out.push({ convId: r.convId, kind: isDm ? 'dm' : 'group', name, label: isDm ? `DM: ${name}` : name, serviceId: m ? m.serviceId : null });
  }
  return out;
}

// Archive-wide counts for the self profile's header, bot excluded. `convIds` limits the
// count to the self sources (defaults to the whole archive).
function selfStats(cdb, convIds = null) {
  const inConv = convIds && convIds.length ? ` AND conv_id IN (${convIds.map(() => '?').join(',')})` : '';
  const p = convIds && convIds.length ? convIds : [];
  const r = cdb.prepare(
    `SELECT SUM(type = 'outgoing') AS mine, SUM(type = 'incoming') AS theirs, MIN(sent_at) AS first, MAX(sent_at) AS last
       FROM messages WHERE src IS NOT ?${inConv}`,
  ).get(BOT_SERVICE_ID, ...p);
  return {
    fromNathan: Number(r && r.mine) || 0,
    fromOthers: Number(r && r.theirs) || 0,
    first: r && r.first ? r.first : null,
    last: r && r.last ? r.last : null,
  };
}

const messagesLine = (s) => `- **Messages:** ${s.fromNathan + s.fromOthers} total (${s.fromOthers} from others, ${s.fromNathan} from Nathan)`;

// Create nathan.md if it is missing, and keep its pipeline-owned `Messages` line
// current (the self-merge prompt tells the model never to touch it). Relationship
// `_self_` is a marker, never a fact; there is deliberately NO Email line — an email on
// this profile is the one value a guest sign-in could match. Returns { created, updated }.
function ensureSelfProfile(cdb, convIds = null) {
  const file = selfProfilePath();
  const s = selfStats(cdb, convIds);
  if (!fs.existsSync(file)) {
    const body = [
      `# ${SELF_NAME}`,
      '',
      '- **Relationship:** _self_',
      '- **Birthday:** _unknown_',
      `- **First contact:** ${s.first ? dateKey(s.first) : 'unknown'}`,
      `- **Last contact:** ${s.last ? dateKey(s.last) : 'unknown'}`,
      messagesLine(s),
      '',
      '## What I know',
      '_Not yet enriched. Run the enrichment pass to distill message history into this section._',
      '',
      '## Timeline',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, body);
    return { created: true, updated: false };
  }
  const md = fs.readFileSync(file, 'utf8');
  const re = /^- \*\*Messages:\*\*.*$/m;
  if (!re.test(md)) return { created: false, updated: false };
  const next = md.replace(re, () => messagesLine(s));
  if (next === md) return { created: false, updated: false };
  writeFileAtomic(file, next);
  return { created: false, updated: true };
}

module.exports = { SELF_SLUG, SELF_NAME, selfProfilePath, selfConversations, selfStats, ensureSelfProfile };
