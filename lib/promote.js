'use strict';
// lib/promote.js — the tracked/untracked boundary WRITE operations, shared by the
// crm-autopromote CLI and the web UI so there is one implementation.
//
//   listCandidates(cdb, sdb) -> untracked private contacts over the activity threshold
//   promoteOne(cdb, sdb, id) -> move ONE person universe->tracked (profile + row + json,
//                               all together, so an orphan row is never created)
//   untrackSlug(slug)        -> move tracked->untracked (drop from json + delete profile;
//                               the sweep's reconcileContacts then removes the row)
const fs = require('fs');
const { TRACKED, CONTACTS_DIR, BOT_SERVICE_ID } = require('./config');
const { writeFileAtomic } = require('./atomic-write');
const { dateKey } = require('./weeks');
const { signalNameDetails } = require('./signal-names');

const DAY = 86_400_000;
const WINDOW_DAYS = 30; // look-back window for "recent activity"
const MIN_MSGS = 25;    // promote if >= this many messages exchanged in the window
const MIN_INCOMING = 5; // ...and at least this many were FROM them (not a one-sided blast)

function slugify(name, fallback) {
  const s = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}
function todayKey() { return dateKey(Date.now()); }
function loadTracked() { try { return JSON.parse(fs.readFileSync(TRACKED, 'utf8')); } catch { return { slugs: [] }; } }
// Atomic (tmp+rename): a torn crm-tracked.json reads back as {slugs:[]} in loadTracked,
// which silently untracks EVERYONE — sweeps and the ingest planner then process nobody
// while the UI still lists people. tmp+rename makes a reader see the whole old or whole
// new file, never a half.
function saveTracked(t) { writeFileAtomic(TRACKED, `${JSON.stringify(t, null, 2)}\n`); }

function trackedServiceIds(cdb, tracked) {
  const ids = new Set();
  for (const slug of tracked.slugs || []) {
    let r;
    try { r = cdb.prepare('SELECT signal_id FROM contacts WHERE file_path = ?').get(`data/contacts/${slug}.md`); } catch { r = null; }
    if (r && r.signal_id) ids.add(r.signal_id);
  }
  return ids;
}

// Untracked private contacts with enough recent back-and-forth to be worth tracking.
// Returns [{ serviceId, e164, name, total, incoming, source, existingSlug|null }], busiest
// first. Pure read — writes nothing.
function listCandidates(cdb, sdb) {
  const tracked = loadTracked();
  const names = signalNameDetails(sdb);
  const trackedIds = trackedServiceIds(cdb, tracked);
  const since = Date.now() - WINDOW_DAYS * DAY;
  const convs = sdb.prepare(
    "SELECT id, serviceId, e164 FROM conversations WHERE type='private' AND serviceId IS NOT NULL"
  ).all();
  const out = [];
  for (const c of convs) {
    if (!c.serviceId || c.serviceId === BOT_SERVICE_ID || trackedIds.has(c.serviceId)) continue;
    const counts = sdb.prepare(
      "SELECT SUM(CASE WHEN type IN ('incoming','outgoing') THEN 1 ELSE 0 END) total, "
      + "SUM(CASE WHEN type='incoming' THEN 1 ELSE 0 END) incoming "
      + 'FROM messages WHERE conversationId = ? AND body IS NOT NULL AND sent_at >= ?'
    ).get([c.id, since]);
    const total = counts.total || 0;
    const incoming = counts.incoming || 0;
    if (total < MIN_MSGS || incoming < MIN_INCOMING) continue;
    const resolved = names.get(c.serviceId) || {};
    let existing;
    try { existing = cdb.prepare('SELECT file_path FROM contacts WHERE signal_id = ?').get(c.serviceId); } catch { existing = null; }
    out.push({
      serviceId: c.serviceId,
      e164: c.e164 || null,
      name: resolved.name || c.e164 || c.serviceId.slice(0, 8),
      total, incoming,
      source: resolved.source || 'signal',
      existingSlug: existing && existing.file_path ? existing.file_path.replace('data/contacts/', '').replace(/\.md$/, '') : null,
    });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

function profileTemplate(name, serviceId, e164) {
  return [
    `# ${name}`, '',
    `- **Signal ID:** ${serviceId}`,
    `- **Phone:** ${e164 || '_unknown_'}`,
    '- **Relationship:** _unknown_',
    '- **First contact:** _unknown_',
    `- **Last contact:** ${todayKey()}`, '',
    '## What I know', '',
    '_(promoted from frequent Signal activity; fills in as the daily refresh runs)_', '',
    '## Timeline', '',
    '## Open questions', '', '',
  ].join('\n');
}

// Promote ONE serviceId to tracked. Writes the contacts row, the profile file, and the
// crm-tracked.json entry together — so a half-tracked state (a row the reconcile would
// prune) never exists. Returns { ok, slug, name } or { ok:false, error }.
function promoteOne(cdb, sdb, serviceId) {
  if (!serviceId) return { ok: false, error: 'no serviceId' };
  const resolved = (signalNameDetails(sdb).get(serviceId)) || {};
  const conv = sdb.prepare("SELECT e164 FROM conversations WHERE serviceId = ? AND type='private' LIMIT 1").get(serviceId) || {};
  const tracked = loadTracked();
  let contactCols;
  try { contactCols = new Set(cdb.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name)); } catch { return { ok: false, error: 'no contacts table' }; }
  const existing = cdb.prepare('SELECT name, file_path FROM contacts WHERE signal_id = ?').get(serviceId);

  let slug;
  let name;
  let insert = null; // { cols, vals } — a NEW row to write, or null when a row already exists
  if (existing && existing.file_path) {
    slug = existing.file_path.replace('data/contacts/', '').replace(/\.md$/, '');
    name = resolved.name || existing.name || slug;
  } else {
    name = resolved.name || conv.e164 || serviceId.slice(0, 8);
    slug = slugify(name, serviceId.slice(0, 8));
    const used = new Set(tracked.slugs);
    // 'nathan' is the reserved OWNER node — a contact literally named "Nathan" must not
    // collapse into it.
    while (slug === 'nathan' || used.has(slug) || fs.existsSync(`${CONTACTS_DIR}/${slug}.md`)) slug += '-2';
    const vals = { signal_id: serviceId, name, phone: conv.e164 || null, file_path: `data/contacts/${slug}.md` };
    insert = { cols: Object.keys(vals).filter((k) => contactCols.has(k)), vals };
  }
  // ORDER MATTERS: write the PROFILE FILE FIRST, then the contacts row, then tracked.json.
  // reconcileContacts (lib/person.js) prunes any contacts row whose profile is absent, so a
  // row inserted before its file could be deleted by a sweep running in that window —
  // leaving a tracked slug + profile with NO row, which sweepContact then skips forever.
  // Writing the file first closes that window (and the web caller also holds the pipeline
  // lock now, so a sweep can't run concurrently at all — this is defence in depth).
  const absPath = `${CONTACTS_DIR}/${slug}.md`;
  if (!fs.existsSync(absPath)) writeFileAtomic(absPath, profileTemplate(name, serviceId, conv.e164));
  if (insert) {
    cdb.prepare(`INSERT INTO contacts (${insert.cols.join(', ')}) VALUES (${insert.cols.map(() => '?').join(', ')})`)
      .run(...insert.cols.map((k) => insert.vals[k]));
  }
  if (!tracked.slugs.includes(slug)) { tracked.slugs.push(slug); saveTracked(tracked); }
  return { ok: true, slug, name };
}

// Untrack: drop the slug from crm-tracked.json and delete its profile. The next sweep's
// reconcileContacts removes the now-orphaned contacts row. Message/mention history is
// left in the archive (a re-promote or the mention rebuild re-attaches what it can).
function untrackSlug(slug) {
  if (!slug) return { ok: false, error: 'no slug' };
  const tracked = loadTracked();
  const had = tracked.slugs.includes(slug);
  if (had) { tracked.slugs = tracked.slugs.filter((s) => s !== slug); saveTracked(tracked); }
  let deleted = false;
  try { const abs = `${CONTACTS_DIR}/${slug}.md`; if (fs.existsSync(abs)) { fs.unlinkSync(abs); deleted = true; } } catch { /* best-effort */ }
  return { ok: had || deleted, slug };
}

module.exports = { listCandidates, promoteOne, untrackSlug, WINDOW_DAYS, MIN_MSGS, MIN_INCOMING };
