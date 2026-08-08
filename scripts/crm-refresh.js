// crm-refresh.js — turns "messages we haven't merged yet" into an ordered list
// of week-aligned CHUNKS, and writes the ledger for one chunk at a time.
//
// This is a library first and a CLI second: crm-daily.js calls planAll() in
// process, then walks each chunk (writeChunkLedger -> merge -> commit cursor ->
// git commit) so every chunk is an independently attributable, independently
// revertible step. Running the file directly just prints the plan.
//
// WEEK-ALIGNED CHUNKING (see lib/weeks.js): a merge never sees a fragment of a
// week. Messages are grouped into Monday-04:00-Pacific weeks, and consecutive
// QUIET weeks are batched together up to a token ceiling — so a contact who
// sends thirty texts a week doesn't cost one full merge per week, while a
// contact who sends two thousand gets a chunk per week. A backfill of a year of
// history is therefore just N sequential ordinary merges; there is no separate
// backfill code path and no ledger big enough to overflow a context window.
//
// PER-CONTACT ROWID CURSOR: the cursor is a crm.db archive rowid watermark, NOT
// a timestamp. Signal's `sent_at` is set by the (possibly clock-skewed) sender
// and linked-device sync can insert older rows late, so a timestamp watermark
// can silently skip messages. rowid only moves forward as rows are inserted
// locally, so a per-contact "highest rowid merged" cursor can never skip a row
// that lands after we last looked. One cursor per contact covers every source
// (their DM plus any groups) at once.
//
// DM + GROUP CHATS: "messages with a person" is not just their 1:1 DM — see
// lib/sources.js, which owns those rules and is shared with compaction and the
// web status board so all three agree.
//
// CRASH SAFETY: this file never writes REFRESH_STATE. The orchestrator advances
// a contact's cursor only AFTER that chunk's merge has actually succeeded, so a
// crash mid-run re-merges the same chunk rather than losing it.
//
// Usage:
//   node scripts/crm-refresh.js                 # print the chunk plan for everyone
//   node scripts/crm-refresh.js --only <slug>   # ...for one contact
//   node scripts/crm-refresh.js --write-first   # also write each contact's first ledger
'use strict';
const fs = require('fs');
const path = require('path');
const { openSignalDb, openCrmDb } = require('../lib/signal-db');
const { runSweep } = require('./crm-archive');
const { resolveSources, buildArchiveQuery } = require('../lib/sources');
const { fmtLocal, planChunks, lastCompleteWeekStart } = require('../lib/weeks');
const { redact } = require('../lib/redact');
const {
  TRACKED, NICKNAMES, REFRESH_STATE, REFRESH_DIR,
} = require('../lib/config');

const DAY = 86_400_000;
// INGEST == BACKFILL. Ingest processes everything past a contact's cursor, week
// by week; a "backfill" is just that with an old (or absent) cursor. A contact
// with NO cursor therefore starts from the very beginning (message id > 0), which
// makes a fresh backfill byte-identical to having played the history forward.
//
// The one exception is the eval harness, which passes an explicit backfillDays
// window (evals/cases.js) to hold out a slice of history: when a finite
// backfillDays is supplied, a no-cursor contact starts `sent_at >= now - N days`;
// when it is null (the production default) a no-cursor contact starts from 0.
// CRM_BACKFILL_DAYS still forces a window by hand if one is ever wanted.
const MERGE_BACKFILL_DAYS = process.env.CRM_BACKFILL_DAYS ? Number(process.env.CRM_BACKFILL_DAYS) : null;

function loadCursors() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(REFRESH_STATE, 'utf8')); } catch { /* no state file yet */ }
  if (!raw || typeof raw !== 'object') return {};
  if (raw.cursors && typeof raw.cursors === 'object') return raw.cursors;
  // Old shape ({ lastRefresh, ranAt }): treat as "no per-contact cursors yet"
  // so every tracked contact backfills exactly once.
  return {};
}

function loadNicknames() {
  try {
    return JSON.parse(fs.readFileSync(NICKNAMES, 'utf8')).byServiceId || {};
  } catch {
    return {};
  }
}

// ---- planning ------------------------------------------------------------------

// Plan one contact: resolve their sources, pull everything past their cursor out
// of the ARCHIVE (never Signal — see crm-archive.js), and cut it into chunks.
// Returns null if the contact has no sources or nothing pending.
function planContact(cdb, sdb, slug, opts) {
  const { cursors, nicks, now, includePartialWeek, backfillDays } = opts;
  const rel = `data/contacts/${slug}.md`;
  const row = cdb.prepare('SELECT signal_id, name FROM contacts WHERE file_path = ?').get(rel);
  if (!row || !row.signal_id) return null;

  const sources = resolveSources(sdb, row.signal_id);
  const hasCursor = Object.prototype.hasOwnProperty.call(cursors, slug);
  // No cursor => start from 0 (the whole archive), UNLESS an explicit backfillDays
  // window is passed (the eval harness). This is what makes ingest == backfill.
  const cursorBefore = hasCursor ? (cursors[slug] || 0) : 0;
  const useWindow = !hasCursor && backfillDays != null;

  // Lower bound: past the cursor (from 0 for a fresh contact), or an explicit
  // window only when the eval harness asks. Upper bound: scheduled runs clamp to
  // the last COMPLETE week so no merge sees a partial one; an on-demand
  // single-contact run passes includePartialWeek to include today's week too.
  const lowClause = useWindow ? 'sent_at >= ?' : 'id > ?';
  const lowParam = useWindow ? now - backfillDays * DAY : cursorBefore;
  const cutoff = lastCompleteWeekStart(now);
  const bound = includePartialWeek
    ? { clause: lowClause, params: [lowParam] }
    : { clause: `${lowClause} AND sent_at < ?`, params: [lowParam, cutoff] };

  const q = buildArchiveQuery(sources, row.signal_id, bound);
  if (!q) return null;
  const msgs = cdb.prepare(q.sql).all(...q.params);
  if (msgs.length === 0) return null;

  const display = (nicks[row.signal_id] && nicks[row.signal_id].name) || row.name;
  // ONE CHUNK PER ACTIVE WEEK (maxWeeks:1): a backfill is then exactly the sequence
  // of weekly merges you'd get playing forward, and weeks with no messages are
  // simply absent (skipped), never an empty merge.
  const chunks = planChunks(msgs, { maxWeeks: 1 });
  return {
    slug,
    name: display,
    profile: rel,
    sources,
    hasCursor,
    cursorBefore,
    total: msgs.length,
    chunks,
  };
}

// Plan every tracked contact (or just one). Sweeps the archive first so the plan
// reflects everything Signal currently has.
function planAll(cdb, sdb, opts = {}) {
  const {
    onlySlug = null,
    includePartialWeek = false,
    now = Date.now(),
    backfillDays = MERGE_BACKFILL_DAYS,
    sweep = true,
  } = opts;

  // ARCHIVE-FIRST: pull anything new out of Signal, then read only the archive.
  // A disappearing message the hourly sweep caught still reaches the merge even
  // if it has since expired from Signal's own database.
  if (sweep) runSweep(cdb, sdb);

  let tracked = JSON.parse(fs.readFileSync(TRACKED, 'utf8')).slugs || [];
  if (onlySlug) tracked = tracked.filter((s) => s === onlySlug);

  const cursors = loadCursors();
  const nicks = loadNicknames();
  const plans = [];
  for (const slug of tracked) {
    const p = planContact(cdb, sdb, slug, { cursors, nicks, now, includePartialWeek, backfillDays });
    if (p) plans.push(p);
  }
  return plans;
}

// ---- ledger writing ------------------------------------------------------------

// Write ONE chunk's ledger to the contact's ledger path, overwriting whatever
// the previous chunk left there. That overwrite is deliberate: crm-daily commits
// after every chunk, so `git log -- data/contacts/_refresh/<slug>.new.txt` in the
// memory history is the full record of every ledger ever fed to a merge, without
// accumulating hundreds of files on disk.
// `dir` defaults to the production ledger directory; evals/ passes a throwaway
// sandbox so building fixtures never clobbers a real pending ledger.
function writeChunkLedger(plan, chunk, chunkIndex, chunkTotal, dir = REFRESH_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${plan.slug}.new.txt`);

  // PROVENANCE: every line carries its ⟨m…⟩ archive id so the merge can cite the
  // exact source messages. Timestamps are Pacific, matching the week boundaries.
  // Speakers were attributed once, at archive time.
  const lines = chunk.msgs.map((m) => {
    const label = plan.sources.labels[m.cid]; // set only for group conversations
    const ctx = label ? `(${label}) ` : '';
    return `[${fmtLocal(m.sent_at)}] ⟨m${m.rid}⟩ ${ctx}${m.sender}: ${redact(m.body)}`;
  });

  const srcBits = [];
  if (plan.sources.dmConvIds.length) srcBits.push('DM');
  for (const cid of [...plan.sources.biGroupConvIds, ...plan.sources.multiGroupConvIds]) {
    if (chunk.msgs.some((m) => m.cid === cid)) srcBits.push(`group "${plan.sources.labels[cid]}"`);
  }

  const header = [
    `# Messages with ${plan.name} — ${chunk.label} (Pacific)`,
    `# chunk ${chunkIndex} of ${chunkTotal} · ${chunk.count} messages · ids m${chunk.ridStart}–m${chunk.ridEnd}`,
    `# window: ${fmtLocal(chunk.startMs)} to ${fmtLocal(chunk.endMs)}${chunk.partial ? ' (partial week — oversized week split by day)' : ''}`,
    `# sources: ${srcBits.join(', ') || 'DM'}`,
  ].join('\n');

  fs.writeFileSync(file, `${header}\n\n${lines.join('\n')}\n`);
  return { file, rel: `data/contacts/_refresh/${plan.slug}.new.txt` };
}

// Chunk -> the flat record crm-daily stores in its run record and prints.
function chunkSummary(plan, chunk, i, total) {
  return {
    slug: plan.slug,
    name: plan.name,
    chunkIndex: i,
    chunkTotal: total,
    label: chunk.label,
    weekStart: chunk.startKey,
    weekEnd: chunk.endKey,
    count: chunk.count,
    tokens: chunk.tokens,
    ridStart: chunk.ridStart,
    ridEnd: chunk.ridEnd,
    partial: chunk.partial,
  };
}

// ---- CLI -----------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--only');
  const onlySlug = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;
  const writeFirst = argv.includes('--write-first');
  const includePartialWeek = Boolean(onlySlug);

  const cdb = openCrmDb();
  const sdb = openSignalDb();
  const plans = planAll(cdb, sdb, { onlySlug, includePartialWeek });

  if (plans.length === 0) {
    console.log('CRM_REFRESH: no unmerged messages for any tracked contact.');
  } else {
    let chunks = 0;
    let msgs = 0;
    console.log('CRM_REFRESH: chunk plan');
    for (const p of plans) {
      chunks += p.chunks.length;
      msgs += p.total;
      console.log(`  ${p.slug} (${p.name}): ${p.total} msgs in ${p.chunks.length} chunk(s)` +
        `${p.hasCursor ? `, cursor ${p.cursorBefore}` : ', BACKFILL (no cursor)'}`);
      p.chunks.forEach((c, i) => {
        console.log(`    ${String(i + 1).padStart(3)}/${p.chunks.length}  ${c.label.padEnd(24)}` +
          `${String(c.count).padStart(6)} msgs  ~${String(Math.round(c.tokens / 1000)).padStart(3)}k tok  ` +
          `m${c.ridStart}–m${c.ridEnd}${c.partial ? '  [day-split]' : ''}`);
      });
      if (writeFirst && p.chunks.length) {
        const { rel } = writeChunkLedger(p, p.chunks[0], 1, p.chunks.length);
        console.log(`    wrote ${rel} (chunk 1)`);
      }
    }
    console.log(`CRM_REFRESH: ${msgs} message(s) across ${chunks} chunk(s), ${plans.length} contact(s).`);
  }

  sdb.close();
  cdb.close();
  // NOTE: REFRESH_STATE is intentionally NOT written here — see header.
}

if (require.main === module) main();
module.exports = { planAll, planContact, writeChunkLedger, chunkSummary, MERGE_BACKFILL_DAYS };
