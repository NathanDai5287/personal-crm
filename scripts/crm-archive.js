// crm-archive.js — the HOURLY archive sweep, and the pipeline's only reader
// of message content from Signal's database.
//
// WHY THIS EXISTS: some people use disappearing messages. A message with a
// 1-day timer can be gone from Signal's DB before the nightly pipeline ever
// sees it. This sweep runs every hour (Task Scheduler) and copies anything
// new into crm.db's permanent archive — no AI, no profile edits, seconds of
// work. The daily pipeline (merge ledgers, Timeline) then reads
// message content FROM THE ARCHIVE, so anything that survived at least one
// hour is never lost to the AI steps, no matter when it expires.
//
// JOBS: this one script backs TWO of the four jobs in lib/jobs.js — `sweep` (the
// hourly incremental copy) and `deep-sweep` (a full re-walk, `--deep`). Both are
// free and ALWAYS run — they carry no enable switch, because pausing archiving
// would risk losing disappearing messages for no cost saving.
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
//   node scripts/crm-archive.js                        # sweep everything new
//   node scripts/crm-archive.js --deep                 # ignore cursors, re-check all history
//   node scripts/crm-archive.js --only <slug>          # one contact (or group:<slug>)
//   node scripts/crm-archive.js --only <slug> --deep   # that contact's FULL history
// Also exported as runSweep(cdb, sdb, {deep, onlySlug}) so crm-refresh.js / crm-timeline.js can
// sweep inline at the start of a daily run (no dependency on the hourly task
// having fired recently).
'use strict';
const fs = require('fs');
const { openSignalDb, openCrmDb } = require('../lib/signal-db');
const { mirrorMessages, ensureMessagesTable, SYNTH_BAND } = require('../lib/archive');
const { resolveSources, buildMessageQuery } = require('../lib/sources');
const M = require('../lib/media');

// Downloaded image/audio attachments carry a plaintextHash; they become OCR/STT
// work. `ocr` for images, `stt` for audio (voice notes).
const MEDIA_CT = /^(image|audio)\//i;
const mediaAtts = (list) => (list || []).filter((a) => a.path && a.plaintextHash && MEDIA_CT.test(a.contentType || ''));
const mediaKind = (ct) => (/^audio\//i.test(ct || '') ? 'stt' : 'ocr');
function enqueueMedia(cdb, entries) {
  if (!entries || !entries.length) return;
  M.ensureMediaTable(cdb);
  for (const e of entries) M.enqueue(cdb, e);
}
const {
  loadAttachments, describeAttachments, composeBody,
  loadPreviews, describePreview, loadQuotes, describeQuote,
} = require('../lib/attachments');
const path = require('path');
const { spawn } = require('child_process');
const {
  TRACKED, TRACKED_GROUPS, DISPLAY_NAMES, ARCHIVE_STATE, MY_SERVICE_ID, BOT_SERVICE_ID,
  ARCHIVE_ID_OFFSET, ROOT,
} = require('../lib/config');

// Fire-and-forget the OCR/STT worker as a detached, low-priority side job so it
// drains the media queue this sweep enqueued without blocking or being tied to the
// sweep's lifetime. A deep sweep also refills from the whole archive. Best-effort:
// it renices itself and idle-exits when the queue is empty.
function kickMediaWorker(deep) {
  try {
    const wArgs = [path.join(__dirname, 'crm-media-worker.js')];
    if (deep) wArgs.push('--enqueue-existing');
    spawn(process.execPath, wArgs, { cwd: ROOT, env: process.env, detached: true, stdio: 'ignore' }).unref();
  } catch { /* worker is best-effort */ }
}

const DAY = 86_400_000;
// FIRST-SWEEP WINDOW for a source with no cursor yet — 0 means "everything
// Signal still holds", which is the default.
//
// It was 30 days, and that was wrong in a way nobody would notice: every
// long-tracked contact already has a cursor, so the window only ever applied to
// a NEWLY tracked person, who therefore got a 30-day archive while everyone else
// had a year of it. Archiving is free — no model, no tokens, seconds of work —
// so the only thing the narrow window bought was a quietly shallower history for
// exactly the contacts whose history nothing else had captured yet.
//
// NOT to be confused with crm-refresh.js's MERGE_BACKFILL_DAYS, which is still
// 30 and costs money: that one decides how many messages a MODEL reads. This one
// only decides what gets copied into crm.db.
const FIRST_SWEEP_DAYS = Number(process.env.CRM_ARCHIVE_BACKFILL_DAYS) || 0;

// OVERLAP on the incremental bound, because Signal REUSES ROWIDS (see the long
// note in lib/archive.js). `rowid > cursor` assumes rowids only ever go up. When
// a disappearing-message timer deletes the highest rows, the next arrival is
// handed a rowid BELOW the cursor and `rowid > cursor` never sees it again —
// silent, permanent loss of exactly the messages this sweep exists to rescue.
//
// So the bound also takes anything sent in the last OVERLAP_HOURS regardless of
// rowid. Re-walking a day of messages every hour is a few hundred rows and the
// mirror is idempotent, which is a trivial price for closing that hole.
const OVERLAP_HOURS = Number(process.env.CRM_ARCHIVE_OVERLAP_HOURS) || 36;

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
// This is the "re-check everything" operation: every source, from the beginning
// of Signal's history, copying whatever the archive is missing. No AI, no cost,
// no profile changes.
// CLI flags (--deep, --only <slug>) are parsed and validated at the bottom of
// this file, INSIDE the `require.main === module` guard — never here at module
// top level. crm-refresh.js / crm-timeline.js require this module for runSweep(),
// and parsing the PARENT process's argv on import would exit on a flag that is
// meaningful to the parent but unknown to the sweep — e.g. `crm-daily.js
// --dry-run` was crashing here before it ever reached the daily pipeline.

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// serviceId -> display name (Signal names overridden by Nathan's display names).
function buildNameMap(sdb, nicks) {
  const m = new Map();
  for (const r of sdb.prepare(
    "SELECT serviceId, COALESCE(name, profileFullName, profileName, e164) AS nm FROM conversations WHERE type='private' AND serviceId IS NOT NULL"
  ).all()) if (r.nm) m.set(r.serviceId, r.nm);
  for (const [sid, info] of Object.entries(nicks)) if (info && info.name) m.set(sid, info.name);
  return m;
}

// The incremental bound for one source, shared by contacts and groups so the
// reuse-overlap can never be applied to one and forgotten on the other.
function sweepBound(cursors, key, now, ranAt, deep) {
  if (!deep && Object.prototype.hasOwnProperty.call(cursors, key)) {
    // ...OR anything recent, whatever its rowid. See OVERLAP_HOURS above.
    // The floor uses the last sweep's clock, not now, so a machine that was off
    // for a week still re-checks the window it actually missed.
    const floor = Math.max(0, (ranAt || now) - OVERLAP_HOURS * 3_600_000);
    return { clause: '(rowid > ? OR sent_at >= ?)', params: [cursors[key] || 0, floor] };
  }
  return { clause: 'sent_at >= ?', params: [deep || !FIRST_SWEEP_DAYS ? 0 : now - FIRST_SWEEP_DAYS * DAY] };
}

// Sweep one contact's sources. Returns { seen, inserted, collisions }.
const NOTHING = { seen: 0, inserted: 0, collisions: [] };

// Voice/video call EVENTS. Signal records them as type='call-history' messages
// (carrying the conversationId + sent_at + a callId) with the details in a separate
// `callsHistory` table. We surface them as archive rows so the merge can see WHY a
// thread went quiet — e.g. the two of you moved to a call. Body renders the kind /
// direction-derived caller / outcome / duration; no message content is involved.
// Returns mirrorMessages items (caller fills in conversation + slug).
function callItems(sdb, convIds, bound, nameFor) {
  if (!convIds.length) return [];
  const ph = convIds.map(() => '?').join(',');
  let rows;
  try {
    rows = sdb.prepare(`
      SELECT rowid AS rid, conversationId AS cid, sent_at AS sentAt, sourceServiceId AS src, json AS j
      FROM messages
      WHERE type = 'call-history' AND conversationId IN (${ph}) AND ${bound.clause}
      ORDER BY rowid ASC`).all([...convIds, ...bound.params]);
  } catch { return []; } // Signal build without call-history rows
  if (!rows.length) return [];
  const detail = sdb.prepare('SELECT type, direction, status, timestamp, endedTimestamp, ringerId FROM callsHistory WHERE callId = ?');
  const items = [];
  for (const r of rows) {
    let callId = null;
    try { callId = JSON.parse(r.j || '{}').callId; } catch { /* no id */ }
    let c = null;
    if (callId) { try { c = detail.get([callId]); } catch { /* no callsHistory table */ } }
    const kind = c && c.type === 'Video' ? 'video' : (c && c.type === 'Group' ? 'group' : 'voice');
    const st = c ? c.status : null;
    const durMin = c && st === 'Accepted' && c.endedTimestamp && c.timestamp
      ? Math.max(1, Math.round((c.endedTimestamp - c.timestamp) / 60000)) : null;
    // Match the ledger's plain "[…]" marker style (see lib/attachments): no emoji.
    let body;
    if (st === 'Missed' || st === 'Declined') body = `[${st.toLowerCase()} ${kind} call]`; // [missed video call]
    else if (durMin != null) body = `[${kind} call, ${durMin}m]`;                          // [video call, 12m]
    else body = `[${kind} call]`;                                                          // [group call] / [voice call]
    const ringer = c ? c.ringerId : r.src;
    const who = (ringer && nameFor(ringer)) || (c && c.direction === 'Outgoing' ? 'Nathan' : 'Someone');
    items.push({ id: r.rid, convId: r.cid, sentAt: r.sentAt, sender: who, body, src: ringer || null, type: 'call' });
  }
  return items;
}
function sweepContact(cdb, sdb, slug, cursors, now, ranAt, nicks, deep, nameMap) {
  const rel = `data/contacts/${slug}.md`;
  const row = cdb.prepare('SELECT signal_id, name FROM contacts WHERE file_path = ?').get(rel);
  if (!row || !row.signal_id) return NOTHING;

  const sources = resolveSources(sdb, row.signal_id);
  const key = `contact:${slug}`;
  const bound = sweepBound(cursors, key, now, ranAt, deep);
  const q = buildMessageQuery(sources, row.signal_id, bound);
  if (!q) return NOTHING; // no message sources at all (so no call sources either)

  const display = (nicks[row.signal_id] && nicks[row.signal_id].name) || row.name;
  const first = display.split(' ')[0];
  const speaker = (m) => {
    if (m.type === 'outgoing' || m.src === MY_SERVICE_ID) return 'Nathan';
    if (m.src === BOT_SERVICE_ID) return 'Janet';
    if (m.src === row.signal_id) return first;
    // A THIRD party speaking in one of this contact's multi-groups. Resolve their
    // real name from the shared map — NOT this contact's name (that froze other
    // people's words under the contact in the archive). 'Someone' only if unknown.
    return (m.src && nameMap.get(m.src)) || 'Someone';
  };
  const nameFor = (sid) => (sid === MY_SERVICE_ID ? 'Nathan' : (sid === BOT_SERVICE_ID ? 'Janet' : (sid === row.signal_id ? first : (nameMap.get(sid) || null))));

  // Call events, computed BEFORE the empty-text guard: a sweep window can hold a
  // call and NO text messages (a thread that went quiet precisely because you moved
  // to a call), and those calls must still be archived — gating them on text
  // message count dropped them permanently for a call-only window.
  const convIds = [...sources.dmConvIds, ...sources.biGroupConvIds, ...sources.multiGroupConvIds];
  const calls = callItems(sdb, convIds, bound, nameFor).map((it) => ({
    ...it, slug, conversation: sources.labels[it.convId] || `DM with ${display}`,
  }));

  const msgs = sdb.prepare(q.sql).all(q.params);
  if (msgs.length === 0 && calls.length === 0) return NOTHING;

  // ENRICHMENT happens once, HERE. Everything downstream reads the archive, so
  // a photo becomes "[photo]", a reply carries what it answers, and a bare URL
  // carries its page title — for the ledger, the merge and the Timeline alike.
  const mids = msgs.map((m) => m.mid);
  const att = loadAttachments(sdb, msgs.filter((m) => m.hasAttachments).map((m) => m.mid));
  const prev = loadPreviews(sdb, mids);
  const quo = loadQuotes(sdb, mids);
  const mediaEntries = [];
  const items = msgs.map((m) => {
    const mAtts = mediaAtts(att.get(m.mid));
    for (const a of mAtts) mediaEntries.push({ hash: a.plaintextHash, kind: mediaKind(a.contentType), contentType: a.contentType });
    return {
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
      // Link to OCR/STT (media_text), folded into ledger/Timeline lines at read time.
      attHashes: mAtts.length ? mAtts.map((a) => a.plaintextHash).join(' ') : null,
    };
  });
  const stats = mirrorMessages(cdb, items.concat(calls));
  enqueueMedia(cdb, mediaEntries);
  let mx = cursors[key] || 0;
  for (const m of msgs) if (m.rid > mx) mx = m.rid;
  for (const c of calls) if (c.id > mx) mx = c.id;
  cursors[key] = mx;
  return stats;
}

// Sweep one tracked group's FULL conversation (all speakers).
function sweepGroup(cdb, sdb, group, cursors, now, ranAt, nameMap, deep) {
  const conv = sdb.prepare('SELECT id FROM conversations WHERE groupId = ? LIMIT 1').get([group.groupId]);
  if (!conv) return NOTHING;
  const key = `group:${group.slug}`;
  const bound = sweepBound(cursors, key, now, ranAt, deep);
  const msgs = sdb.prepare(`
    SELECT rowid AS rid, id AS mid, body, sent_at, type, sourceServiceId AS src, hasAttachments
    FROM messages
    WHERE conversationId = ? AND (body IS NOT NULL OR hasAttachments = 1)
      AND type IN ('incoming','outgoing')
      AND ${bound.clause}
    ORDER BY rowid ASC`).all([conv.id, ...bound.params]);

  const speaker = (m) => {
    if (m.type === 'outgoing' || m.src === MY_SERVICE_ID) return 'Nathan';
    if (m.src === BOT_SERVICE_ID) return 'Janet';
    return nameMap.get(m.src) || 'Someone';
  };
  // In a group the quoted author can be anyone, so resolve against the full map.
  const nameFor = (sid) => (sid === MY_SERVICE_ID ? 'Nathan' : nameMap.get(sid) || null);
  // Calls first (see sweepContact): a call-only window must still be archived.
  const calls = callItems(sdb, [conv.id], bound, nameFor).map((it) => ({ ...it, slug: null, conversation: group.name }));
  if (msgs.length === 0 && calls.length === 0) return NOTHING;

  const mids = msgs.map((m) => m.mid);
  const att = loadAttachments(sdb, msgs.filter((m) => m.hasAttachments).map((m) => m.mid));
  const prev = loadPreviews(sdb, mids);
  const quo = loadQuotes(sdb, mids);
  const mediaEntries = [];
  const items = msgs.map((m) => {
    const mAtts = mediaAtts(att.get(m.mid));
    for (const a of mAtts) mediaEntries.push({ hash: a.plaintextHash, kind: mediaKind(a.contentType), contentType: a.contentType });
    return {
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
      attHashes: mAtts.length ? mAtts.map((a) => a.plaintextHash).join(' ') : null,
    };
  });
  const stats = mirrorMessages(cdb, items.concat(calls));
  enqueueMedia(cdb, mediaEntries);
  let mx = cursors[key] || 0;
  for (const m of msgs) if (m.rid > mx) mx = m.rid;
  for (const c of calls) if (c.id > mx) mx = c.id;
  cursors[key] = mx;
  return stats;
}

// One-time metadata backfill: rows archived before src/type existed get their
// metadata copied over from Signal (content untouched). After the first run
// this matches zero rows and costs nothing.
function backfillMeta(cdb, sdb) {
  const nulls = cdb.prepare('SELECT id FROM messages WHERE type IS NULL').all();
  if (nulls.length === 0) return 0;
  let n = 0;
  // On a SECONDARY device (offset set) the archive id is NOT this machine's Signal
  // rowid — copied rows keep the origin device's rowid, self-swept rows are
  // rowid+offset — so a `WHERE rowid = id` lookup here would read an unrelated
  // local message and stamp its src/type onto the wrong archive row. Skip the
  // Signal lookup entirely there and rely on the device-independent sender-based
  // inference below (a primary device, offset 0, keeps the exact lookup).
  if (!ARCHIVE_ID_OFFSET) {
    const look = sdb.prepare('SELECT type, sourceServiceId AS src FROM messages WHERE rowid = ?');
    const set = cdb.prepare('UPDATE messages SET src = ?, type = ? WHERE id = ?');
    for (const { id } of nulls) {
      const r = look.get([id]); // vendored sqlcipher driver: params must be an array
      if (r) { set.run(r.src, r.type, id); n++; }
    }
  }
  // Rows whose Signal original is ALREADY GONE (deleted / disappeared) can't
  // be looked up — infer direction from the stored sender label so source-rule
  // queries never drop them. src stays NULL (unknowable).
  cdb.prepare("UPDATE messages SET type = CASE WHEN sender = 'Nathan' THEN 'outgoing' ELSE 'incoming' END WHERE type IS NULL").run();
  return n;
}

// The whole sweep. Safe to call from other scripts (refresh/timeline) before
// they read the archive. Returns { seen, backfilledMeta }.
// opts: { deep, onlySlug }. onlySlug narrows to one contact, or to one group when
// prefixed `group:`; an unknown slug is an error rather than a silent no-op,
// because "swept 0 messages" is indistinguishable from a typo.
function runSweep(cdb, sdb, opts = {}) {
  const deep = Boolean(opts.deep);
  const onlySlug = opts.onlySlug || null;
  const now = Date.now();
  const nicks = loadJson(DISPLAY_NAMES, {}).byServiceId || {};
  const state = loadJson(ARCHIVE_STATE, {});
  const cursors = (state && state.cursors) || {};
  const ranAt = state && state.ranAt;

  ensureMessagesTable(cdb); // creates the table and adds src/type if missing
  const backfilledMeta = backfillMeta(cdb, sdb);

  let seen = 0;
  let inserted = 0;
  const collisions = [];
  const per = {}; // slug -> newly inserted rows, for the run record
  const tally = (name, s) => {
    seen += s.seen;
    inserted += s.inserted;
    if (s.inserted) per[name] = s.inserted;
    for (const c of s.collisions) collisions.push({ ...c, source: name });
  };

  let slugs = loadJson(TRACKED, {}).slugs || [];
  let groups = loadJson(TRACKED_GROUPS, {}).groups || [];
  if (onlySlug) {
    const g = onlySlug.startsWith('group:') ? onlySlug.slice(6) : null;
    slugs = g ? [] : slugs.filter((s) => s === onlySlug);
    groups = g ? groups.filter((x) => x.slug === g) : [];
    if (slugs.length === 0 && groups.length === 0) {
      throw new Error(`--only ${onlySlug}: not a tracked contact or group`);
    }
  }

  // Built once and shared by BOTH sweep paths. The per-contact sweep needs it so a
  // THIRD party in one of the contact's multi-groups is labeled with their own
  // name, not the contact's (the group speaker-attribution bug).
  const nameMap = buildNameMap(sdb, nicks);
  for (const slug of slugs) tally(slug, sweepContact(cdb, sdb, slug, cursors, now, ranAt, nicks, deep, nameMap));
  if (groups.length) {
    for (const g of groups) tally(`group:${g.slug}`, sweepGroup(cdb, sdb, g, cursors, now, ranAt, nameMap, deep));
  }

  // REUSE DETECTOR. An archive whose highest id is ahead of Signal's highest
  // rowid proves rows have been deleted off the top of Signal's table, which is
  // the precondition for rowid reuse. Reported so the condition is visible
  // BEFORE it costs anything; the handling in lib/archive.js is what makes it
  // survivable. A single-contact sweep still reports it — it is a property of the
  // whole database, not of the contact.
  let reuse = null;
  // Only meaningful on a PRIMARY device, where archive ids ARE the local Signal
  // rowids. On a secondary device every self-swept id is rowid+ARCHIVE_ID_OFFSET
  // (100M), always far above the local Signal max rowid, so the test would cry wolf
  // on every sweep. The offset path has its own (sent_at, type) dedup, so the
  // archive-id-vs-rowid comparison simply does not apply there.
  if (!ARCHIVE_ID_OFFSET) {
    try {
      const a = cdb.prepare('SELECT max(id) m FROM messages').get();
      const s = sdb.prepare('SELECT max(rowid) m FROM messages').get([]);
      if (a && s && a.m != null && s.m != null) {
        // Synthetic ids live in a band far above any real rowid; they are the
        // RESULT of reuse, not evidence of it, so they must not trip the test.
        const realMax = cdb.prepare('SELECT max(id) m FROM messages WHERE id < ?').get(SYNTH_BAND).m;
        if (realMax != null && realMax > s.m) reuse = { archiveMax: realMax, signalMax: s.m };
      }
    } catch { /* detector is advisory */ }
  }

  // A single-contact sweep must not stamp `ranAt`: the overlap floor is derived
  // from it, and moving it forward for everyone after sweeping one person would
  // shrink everyone else's window to nothing.
  //
  // Two clocks, each independent so the dashboard can dial them separately:
  //   ranAt      last full sweep of ANY kind — the hourly incremental cadence.
  //   deepRanAt  last full DEEP sweep — the daily deep-sweep cadence.
  // Each is preserved across sweeps that don't set it, so a deep run advances
  // both while an incremental run advances only `ranAt`.
  const out = { cursors, ranAt: onlySlug ? ranAt : now };
  const deepRanAt = (deep && !onlySlug) ? now : (state && state.deepRanAt);
  if (deepRanAt) out.deepRanAt = deepRanAt;
  atomicWriteJson(ARCHIVE_STATE, out);
  return { seen, inserted, per, collisions, reuse, backfilledMeta, deep, onlySlug };
}

function main({ deep, only }) {
  const startedAt = Date.now();
  const cdb = openCrmDb();
  const sdb = openSignalDb();
  let r;
  try {
    r = runSweep(cdb, sdb, { deep, onlySlug: only });
    const scope = `${deep ? ' [DEEP]' : ''}${only ? ` [ONLY ${only}]` : ''}`;
    console.log(`CRM_ARCHIVE:${scope} examined ${r.seen} message(s), ${r.inserted} new` +
      `${r.backfilledMeta ? `, backfilled meta on ${r.backfilledMeta} old row(s)` : ''}.`);
    for (const [name, n] of Object.entries(r.per)) console.log(`  ${name}: +${n}`);
    for (const c of r.collisions) {
      console.log(c.dropped
        ? `  !! REUSED ROWID m${c.rowid} (${c.source}): out of band slots, message NOT archived`
        : `  ** reused rowid m${c.rowid} (${c.source}): arrival rehomed to m${c.id}`);
    }
    if (r.reuse) {
      console.log(`  note: archive max id m${r.reuse.archiveMax} is ahead of Signal's max rowid ` +
        `${r.reuse.signalMax} — rows have been deleted off the top, so rowid reuse is live.`);
    }
  } finally {
    sdb.close();
    cdb.close();
  }
  // Drain the OCR/STT queue out of band (a full sweep only; --only is a targeted run).
  if (!only) kickMediaWorker(deep);
  // Record this pass in the /admin/runs ledger. Every sweep is logged, even a
  // 0-new tick; the dashboard hides those (crm-web runsPage) so the hourly
  // cadence doesn't bury the weekly AI runs, but the ledger stays complete.
  // A run-record failure must never fail the sweep, so it is non-fatal.
  const endedAt = Date.now();
  try {
    require('../lib/run-record').writeRunRecord({
      kind: 'sweep',
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      deep: !!deep,
      only: only || null,
      seen: r.seen,
      inserted: r.inserted,
      per: r.per,
      collisions: r.collisions ? r.collisions.length : 0,
      reuse: r.reuse || null,
      backfilledMeta: r.backfilledMeta || 0,
    });
  } catch (e) {
    console.log(`crm-archive: run-record not written (non-fatal): ${e.message}`);
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  // A misspelled --deepp silently performs the narrow sweep you did not ask for,
  // so an unknown flag aborts rather than falling through to a default.
  const known = new Set(['--deep', '--only']);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    if (argv[i] === '--only') { i += 1; continue; }
    if (!known.has(argv[i])) {
      console.error(`crm-archive: unknown flag '${argv[i]}'\nknown: --deep, --only <slug>`);
      process.exit(2);
    }
  }
  // The sweeps carry no run-toggle — they are free and always run (see the header).
  const deep = argv.includes('--deep');
  // --only <slug>: sweep ONE contact (or one group, as `group:<slug>`) — the
  // dashboard's per-person archive button and targeted "pull his whole history
  // right now" both need this, where a full sweep re-walks 83k rows.
  const onlyIdx = argv.indexOf('--only');
  let only = null;
  if (onlyIdx !== -1) {
    only = argv[onlyIdx + 1];
    if (!only || only.startsWith('--')) { console.error('crm-archive: --only requires a slug'); process.exit(2); }
  }
  // Cross-process pipeline lock: never sweep crm.db while another run (a
  // scheduled sweep, a web-triggered job, a manual CLI run) is writing it. A
  // scheduled loser exits 0 so Task Scheduler does not flag a failure.
  const lock = require('../lib/pipeline-lock').acquire('archive');
  if (!lock.ok) { console.log(`crm-archive: skipped, run in progress (${lock.holderDesc}).`); process.exit(0); }
  try { main({ deep, only }); }
  finally { lock.release(); }
}
module.exports = { runSweep };
