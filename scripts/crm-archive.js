// crm-archive.js — the HOURLY archive sweep, and the pipeline's only reader
// of message content from Signal's database.
//
// WHY THIS EXISTS: some people use disappearing messages. A message with a
// 1-day timer can be gone from Signal's DB before the nightly pipeline ever
// sees it. This sweep runs every hour (Task Scheduler) and copies anything
// new into crm.db's permanent archive — no AI, no profile edits, seconds of
// work. The daily pipeline (merge ledgers, compaction timelines) then reads
// message content FROM THE ARCHIVE, so anything that survived at least one
// hour is never lost to the AI steps, no matter when it expires.
//
// WHAT IT SWEEPS:
//   - every tracked contact's sources (DM + bi-groups + multi-groups, the
//     same rules as everywhere else, via lib/sources.js)
//   - every tracked GROUP's full conversation (all speakers — group timelines
//     need everyone's messages, not just tracked contacts')
//
// CURSORS: its own per-source rowid cursors in data/crm-archive-state.json —
// completely independent of the merge cursors in crm-refresh-state.json.
// Mirroring is INSERT OR IGNORE (idempotent), so the crash-safety story is
// trivial: cursors are written once at the end; a crash just re-sweeps.
//
// Usage:
//   node scripts/crm-archive.js          # sweep everything new
// Also exported as runSweep(cdb, sdb, {deep}) so crm-refresh.js / crm-compact.js can
// sweep inline at the start of a daily run (no dependency on the hourly task
// having fired recently).
'use strict';
const fs = require('fs');
const { openSignalDb, openCrmDb } = require('../lib/signal-db');
const { mirrorMessages, ensureMessagesTable } = require('../lib/archive');
const { resolveSources, buildMessageQuery } = require('../lib/sources');
const {
  loadAttachments, describeAttachments, composeBody,
  loadPreviews, describePreview, loadQuotes, describeQuote,
} = require('../lib/attachments');
const {
  TRACKED, TRACKED_GROUPS, NICKNAMES, ARCHIVE_STATE, MY_SERVICE_ID, BOT_SERVICE_ID,
} = require('../lib/config');

const DAY = 86_400_000;
// First-sweep window for a source with no cursor yet. The hourly sweep only ever
// needs the recent past; `--deep` (below) is how you pull older history in.
const BACKFILL_DAYS = Number(process.env.CRM_ARCHIVE_BACKFILL_DAYS) || 30;

// DEEP SWEEP: ignore cursors entirely and re-sweep every source from the
// beginning of Signal's history, copying anything the archive is missing.
//
// Why a flag rather than just raising BACKFILL_DAYS: cursors already exist, so
// the incremental bound is `rowid > cursor` and a wider window would change
// nothing. --deep drops to the sent_at bound instead. Mirroring is
// INSERT OR IGNORE, so re-walking rows already archived is a no-op — the sweep
// is idempotent and safe to re-run.
//
//   node scripts/crm-archive.js --deep
//
// This is the "widen the archive to full history" operation: it takes the
// archive from ~30 days to everything Signal still holds (~78k messages for
// tracked contacts). No AI, no cost, no profile changes.
const DEEP = process.argv.includes('--deep');

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// serviceId -> display name (Signal names overridden by Nathan's nicknames).
function buildNameMap(sdb, nicks) {
  const m = new Map();
  for (const r of sdb.prepare(
    "SELECT serviceId, COALESCE(name, profileFullName, profileName, e164) AS nm FROM conversations WHERE type='private' AND serviceId IS NOT NULL"
  ).all()) if (r.nm) m.set(r.serviceId, r.nm);
  for (const [sid, info] of Object.entries(nicks)) if (info && info.name) m.set(sid, info.name);
  return m;
}

// Sweep one contact's sources. Returns the number of newly-seen rows.
function sweepContact(cdb, sdb, slug, cursors, now, nicks, deep) {
  const rel = `data/contacts/${slug}.md`;
  const row = cdb.prepare('SELECT signal_id, name FROM contacts WHERE file_path = ?').get(rel);
  if (!row || !row.signal_id) return 0;

  const sources = resolveSources(sdb, row.signal_id);
  const key = `contact:${slug}`;
  const bound = (!deep && Object.prototype.hasOwnProperty.call(cursors, key))
    ? { clause: 'rowid > ?', param: cursors[key] || 0 }
    : { clause: 'sent_at >= ?', param: deep ? 0 : now - BACKFILL_DAYS * DAY };
  const q = buildMessageQuery(sources, row.signal_id, bound);
  if (!q) return 0;
  const msgs = sdb.prepare(q.sql).all(q.params);
  if (msgs.length === 0) return 0;

  const display = (nicks[row.signal_id] && nicks[row.signal_id].name) || row.name;
  const first = display.split(' ')[0];
  const speaker = (m) => {
    if (m.src === MY_SERVICE_ID) return 'Nathan';
    if (m.src === row.signal_id) return first;
    return m.type === 'outgoing' ? 'Nathan' : first;
  };
  // ENRICHMENT happens once, HERE. Everything downstream reads the archive, so
  // a photo becomes "[photo]", a reply carries what it answers, and a bare URL
  // carries its page title — for the ledger, the merge and the Timeline alike.
  const mids = msgs.map((m) => m.mid);
  const att = loadAttachments(sdb, msgs.filter((m) => m.hasAttachments).map((m) => m.mid));
  const prev = loadPreviews(sdb, mids);
  const quo = loadQuotes(sdb, mids);
  const nameFor = (sid) => (sid === MY_SERVICE_ID ? 'Nathan' : (sid === row.signal_id ? first : null));
  mirrorMessages(cdb, msgs.map((m) => ({
    id: m.rid,
    convId: m.cid,
    conversation: sources.labels[m.cid] || `DM with ${display}`,
    slug,
    sentAt: m.sent_at,
    sender: speaker(m),
    body: composeBody(
      m.body,
      describeQuote(quo.get(m.mid), nameFor),
      describeAttachments(att.get(m.mid)),
      describePreview(prev.get(m.mid)),
    ),
    src: m.src,
    type: m.type,
    // Lets the archive upgrade a row stored before these enrichments existed.
    enriched: Boolean(m.hasAttachments) || prev.has(m.mid) || quo.has(m.mid),
  })));
  cursors[key] = msgs.reduce((mx, m) => Math.max(mx, m.rid), cursors[key] || 0);
  return msgs.length;
}

// Sweep one tracked group's FULL conversation (all speakers).
function sweepGroup(cdb, sdb, group, cursors, now, nameMap, deep) {
  const conv = sdb.prepare('SELECT id FROM conversations WHERE groupId = ? LIMIT 1').get([group.groupId]);
  if (!conv) return 0;
  const key = `group:${group.slug}`;
  const bound = (!deep && Object.prototype.hasOwnProperty.call(cursors, key))
    ? { clause: 'rowid > ?', param: cursors[key] || 0 }
    : { clause: 'sent_at >= ?', param: deep ? 0 : now - BACKFILL_DAYS * DAY };
  const msgs = sdb.prepare(`
    SELECT rowid AS rid, id AS mid, body, sent_at, type, sourceServiceId AS src, hasAttachments
    FROM messages
    WHERE conversationId = ? AND (body IS NOT NULL OR hasAttachments = 1)
      AND type IN ('incoming','outgoing')
      AND ${bound.clause}
    ORDER BY rowid ASC`).all([conv.id, bound.param]);
  if (msgs.length === 0) return 0;

  const speaker = (m) => {
    if (m.type === 'outgoing' || m.src === MY_SERVICE_ID) return 'Nathan';
    if (m.src === BOT_SERVICE_ID) return 'Janet';
    return nameMap.get(m.src) || 'Someone';
  };
  const mids = msgs.map((m) => m.mid);
  const att = loadAttachments(sdb, msgs.filter((m) => m.hasAttachments).map((m) => m.mid));
  const prev = loadPreviews(sdb, mids);
  const quo = loadQuotes(sdb, mids);
  // In a group the quoted author can be anyone, so resolve against the full map.
  const nameFor = (sid) => (sid === MY_SERVICE_ID ? 'Nathan' : nameMap.get(sid) || null);
  mirrorMessages(cdb, msgs.map((m) => ({
    id: m.rid,
    convId: conv.id,
    conversation: group.name,
    slug: null,
    sentAt: m.sent_at,
    sender: speaker(m),
    body: composeBody(
      m.body,
      describeQuote(quo.get(m.mid), nameFor),
      describeAttachments(att.get(m.mid)),
      describePreview(prev.get(m.mid)),
    ),
    src: m.src,
    type: m.type,
    enriched: Boolean(m.hasAttachments) || prev.has(m.mid) || quo.has(m.mid),
  })));
  cursors[key] = msgs.reduce((mx, m) => Math.max(mx, m.rid), cursors[key] || 0);
  return msgs.length;
}

// One-time metadata backfill: rows archived before src/type existed get their
// metadata copied over from Signal (content untouched). After the first run
// this matches zero rows and costs nothing.
function backfillMeta(cdb, sdb) {
  const nulls = cdb.prepare('SELECT id FROM messages WHERE type IS NULL').all();
  if (nulls.length === 0) return 0;
  const look = sdb.prepare('SELECT type, sourceServiceId AS src FROM messages WHERE rowid = ?');
  const set = cdb.prepare('UPDATE messages SET src = ?, type = ? WHERE id = ?');
  let n = 0;
  for (const { id } of nulls) {
    const r = look.get([id]); // vendored sqlcipher driver: params must be an array
    if (r) { set.run(r.src, r.type, id); n++; }
  }
  // Rows whose Signal original is ALREADY GONE (deleted / disappeared) can't
  // be looked up — infer direction from the stored sender label so source-rule
  // queries never drop them. src stays NULL (unknowable).
  cdb.prepare("UPDATE messages SET type = CASE WHEN sender = 'Nathan' THEN 'outgoing' ELSE 'incoming' END WHERE type IS NULL").run();
  return n;
}

// The whole sweep. Safe to call from other scripts (refresh/compact) before
// they read the archive. Returns { seen, backfilledMeta }.
function runSweep(cdb, sdb, opts = {}) {
  const deep = Boolean(opts.deep);
  const now = Date.now();
  const nicks = loadJson(NICKNAMES, {}).byServiceId || {};
  const state = loadJson(ARCHIVE_STATE, {});
  const cursors = (state && state.cursors) || {};

  ensureMessagesTable(cdb); // creates the table and adds src/type if missing
  const backfilledMeta = backfillMeta(cdb, sdb);

  let seen = 0;
  const slugs = loadJson(TRACKED, {}).slugs || [];
  for (const slug of slugs) seen += sweepContact(cdb, sdb, slug, cursors, now, nicks, deep);

  const groups = loadJson(TRACKED_GROUPS, {}).groups || [];
  if (groups.length) {
    const nameMap = buildNameMap(sdb, nicks);
    for (const g of groups) seen += sweepGroup(cdb, sdb, g, cursors, now, nameMap, deep);
  }

  atomicWriteJson(ARCHIVE_STATE, { cursors, ranAt: now });
  return { seen, backfilledMeta };
}

function main() {
  const cdb = openCrmDb();
  const sdb = openSignalDb();
  try {
    const r = runSweep(cdb, sdb, { deep: DEEP });
    console.log(`CRM_ARCHIVE:${DEEP ? ' [DEEP]' : ''} swept ${r.seen} message(s)${r.backfilledMeta ? `, backfilled meta on ${r.backfilledMeta} old row(s)` : ''}.`);
  } finally {
    sdb.close();
    cdb.close();
  }
}

if (require.main === module) main();
module.exports = { runSweep };
