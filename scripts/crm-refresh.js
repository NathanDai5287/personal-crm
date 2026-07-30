// Incremental CRM refresh. Pulls only messages newer than each contact's own
// per-contact cursor (a Signal messages.rowid watermark, NOT a timestamp),
// writes a per-contact "new messages" file for anyone with fresh activity,
// bumps last_contact_at, and prints a manifest. No model, no sends.
//
// Per-contact rowid cursor (the fix): the original cron used ONE global
// `lastRefresh` timestamp watermark for every contact. That's fragile —
// Signal's `sent_at` is set by the (possibly clock-skewed) sender, and
// linked-device sync can insert older messages asynchronously, so a global
// timestamp watermark can silently skip messages whose sent_at falls behind
// a watermark already advanced by other contacts' newer messages. `rowid` is
// SQLite's monotonic local insertion order for the `messages` table: it only
// moves forward as rows are inserted into by THIS Signal Desktop install, so
// a per-contact "highest rowid we've merged" cursor can never skip a row
// that lands in the DB after we last looked, regardless of sender clock
// skew or when a synced message actually arrives. rowid is global across the
// whole `messages` table, so ONE cursor per contact covers every conversation
// we pull that contact from (their DM plus any groups) at once.
//
// DM + GROUP CHATS: "all messages with a person" is not just their 1:1 DM.
// For each contact we pull from:
//   (a) their DM/private conversation  -> ALL messages (both directions).
//   (b) group chats where they are the ONLY other party besides me and the
//       old bot (e.g. "Nat & Kat") -> ALL messages from me or them (the bot's
//       messages are dropped). These are effectively private channels.
//   (c) larger group chats they're a member of -> ONLY that contact's own
//       messages (sourceServiceId = contact), tagged with the group name, so
//       the profile captures what THEY said without importing everyone else.
// Speaker attribution and the "other party" test use MY_SERVICE_ID /
// BOT_SERVICE_ID from config.
//
// State shape: { cursors: { "<slug>": <lastRowid>, ... }, ranAt: <ms> }.
// If the OLD shape ({ lastRefresh, ranAt }) is found, it is treated as "no
// per-contact cursors yet" (cursors = {}) — every tracked slug then falls
// into the "new contact" backfill path below exactly once.
//
// CRASH SAFETY: this script never writes REFRESH_STATE. It only reads the
// current cursors (to know where to start) and prints a manifest with a
// `proposedCursor` per contact. The orchestrator (crm-daily.js) is
// responsible for advancing a contact's cursor in REFRESH_STATE, and only
// AFTER that contact's merge into their profile has actually succeeded. If
// the process crashes mid-run (or a merge fails), the cursor stays where it
// was, and the same messages get retried on the next run instead of being
// lost.
//
// Usage:
//   node scripts/crm-refresh.js                 # all tracked contacts
//   node scripts/crm-refresh.js --only <slug>   # just one contact (dry ledger)
const fs = require('fs');
const path = require('path');
const { openSignalDb, openCrmDb } = require('../lib/signal-db');
const { runSweep } = require('./crm-archive');
const { resolveSources, buildArchiveQuery } = require('../lib/sources');
const {
  TRACKED, NICKNAMES, REFRESH_STATE, REFRESH_DIR,
} = require('../lib/config');

const DAY = 86_400_000;
const BACKFILL_DAYS = 30; // new-contact backfill window (by sent_at)

function pad(n) { return String(n).padStart(2, '0'); }
function fmtTs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function loadCursors() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(REFRESH_STATE, 'utf8')); } catch { /* no state file yet */ }
  if (!raw || typeof raw !== 'object') return {};
  if (raw.cursors && typeof raw.cursors === 'object') return raw.cursors;
  // Old shape ({ lastRefresh, ranAt }) or anything else unrecognized: treat
  // as "no per-contact cursors yet" so every tracked contact backfills once.
  return {};
}

function loadNicknames() {
  try {
    return JSON.parse(fs.readFileSync(NICKNAMES, 'utf8')).byServiceId || {};
  } catch {
    return {};
  }
}

// Source resolution AND the message query (DM + bi-group + multi-group,
// including the NULL-src outgoing fix) live in lib/sources.js, shared with
// crm-compact.js and crm-web.js so ledgers, timelines, and the status board
// all agree on what counts as "messages with this person".

function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--only');
  const onlySlug = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;

  let tracked = JSON.parse(fs.readFileSync(TRACKED, 'utf8')).slugs || [];
  if (onlySlug) tracked = tracked.filter((s) => s === onlySlug);

  const cursors = loadCursors();
  const nicks = loadNicknames();

  const cdb = openCrmDb();
  const sdb = openSignalDb();

  // ARCHIVE-FIRST: sweep anything new from Signal into crm.db's archive, then
  // build every ledger FROM THE ARCHIVE. Signal is never read for message
  // content here — so a disappearing message that the hourly sweep caught
  // still reaches the merge even if it has since expired from Signal's DB.
  runSweep(cdb, sdb);

  fs.mkdirSync(REFRESH_DIR, { recursive: true });

  const manifest = [];
  const now = Date.now();

  for (const slug of tracked) {
    const rel = `data/contacts/${slug}.md`;
    const row = cdb.prepare('SELECT signal_id, name FROM contacts WHERE file_path = ?').get(rel);
    if (!row || !row.signal_id) continue;

    const sources = resolveSources(sdb, row.signal_id);
    const hasCursor = Object.prototype.hasOwnProperty.call(cursors, slug);
    const bound = hasCursor
      ? { clause: 'id > ?', param: cursors[slug] || 0 }
      : { clause: 'sent_at >= ?', param: now - BACKFILL_DAYS * DAY };

    const q = buildArchiveQuery(sources, row.signal_id, bound);
    if (!q) continue;
    const msgs = cdb.prepare(q.sql).all(...q.params);
    if (msgs.length === 0) continue;

    const display = (nicks[row.signal_id] && nicks[row.signal_id].name) || row.name;
    // PROVENANCE: every line carries the message's ⟨m<id>⟩ archive id, so the
    // merge model can cite the exact source messages behind what it writes.
    // Speaker labels were attributed once, at archive time.
    const lines = msgs.map((m) => {
      const label = sources.labels[m.cid]; // set only for group convs
      const ctx = label ? `(${label}) ` : '';
      return `[${fmtTs(m.sent_at)}] ⟨m${m.rid}⟩ ${ctx}${m.sender}: ${m.body}`;
    });

    // Describe which sources contributed, for the file header.
    const srcBits = [];
    if (sources.dmConvIds.length) srcBits.push('DM');
    for (const cid of [...sources.biGroupConvIds, ...sources.multiGroupConvIds]) {
      if (msgs.some((m) => m.cid === cid)) srcBits.push(`group "${sources.labels[cid]}"`);
    }
    const headerSince = hasCursor
      ? 'since last refresh'
      : `since ${fmtTs(now - BACKFILL_DAYS * DAY)} (new contact backfill, ${BACKFILL_DAYS}d)`;
    const outFile = path.join(REFRESH_DIR, `${slug}.new.txt`);
    fs.writeFileSync(
      outFile,
      `# New messages with ${display} ${headerSince}\n# sources: ${srcBits.join(', ') || 'DM'}\n# ${msgs.length} messages\n\n${lines.join('\n')}`
    );

    const proposedCursor = msgs.reduce((mx, m) => Math.max(mx, m.rid), 0);
    const lastSentAt = msgs.reduce((mx, m) => Math.max(mx, m.sent_at), 0);
    cdb.prepare('UPDATE contacts SET last_contact_at = ? WHERE file_path = ?').run(lastSentAt, rel);

    manifest.push({
      slug,
      name: display,
      count: msgs.length,
      profile: rel,
      newFile: `data/contacts/_refresh/${slug}.new.txt`,
      proposedCursor,
    });
  }

  sdb.close();
  cdb.close();

  // NOTE: REFRESH_STATE is intentionally NOT written here. See header comment
  // for the crash-safety rationale — the orchestrator commits cursors
  // per-contact, only after that contact's merge succeeds.

  if (manifest.length === 0) {
    console.log('CRM_REFRESH: no new messages for any tracked contact.');
  } else {
    console.log('CRM_REFRESH: contacts with new activity:');
    for (const m of manifest) console.log(JSON.stringify(m));
  }
}

main();
