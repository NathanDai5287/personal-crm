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
// GATED CADENCE (config INGEST_N / _FLOOR_DAYS / _CEILING_DAYS): a contact is NOT
// merged every active week. planContact accumulates the backlog and releases a
// merge only when it crosses N messages (after the floor has elapsed) or the
// ceiling forces one; each released bucket is then week-batched as above. The
// decision is a pure function of (backlog, last-merge time, effective date), so a
// one-shot backfill emits the SAME buckets as day-by-day live runs — the cron
// only has to fire, it makes no decisions. See gateBuckets().
//
// PER-CONTACT MERGE LEDGER: the merge frontier is the `merged` table in crm.db
// (lib/archive.js) — the explicit set of (contact, message) pairs already merged —
// NOT a rowid cursor. That lets ingest read the backlog OLDEST-FIRST (profiles build
// chronologically) while staying lossless: a message that linked-device sync inserts
// late with an OLD sent_at is simply "not in the merged set", so it is picked up in
// its date place instead of being skipped by an advancing watermark. One ledger per
// contact covers every source (their DM plus any groups) at once.
//
// DM + GROUP CHATS: "messages with a person" is not just their 1:1 DM — see
// lib/sources.js, which owns those rules and is shared with the Timeline step and the
// web status board so all three agree.
//
// CRASH SAFETY: crm-daily records a chunk's messages in the `merged` table only
// AFTER that chunk's merge has actually succeeded, so a crash mid-run re-merges the
// same chunk rather than losing it.
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
const { fmtLocal, planChunks, lastCompleteWeekStart, gateBuckets } = require('../lib/weeks');
const { redact } = require('../lib/redact');
const { confirmedNicknames } = require('../lib/nicknames');
const { foldSuffix } = require('../lib/media');
const { buildResolver } = require('../lib/people-resolve');
const {
  TRACKED, DISPLAY_NAMES, REFRESH_DIR, CONTACTS_DIR, BOT_SERVICE_ID,
  INGEST_N, INGEST_FLOOR_DAYS, INGEST_CEILING_DAYS,
} = require('../lib/config');

// CAST OF CHARACTERS: the other tracked people a conversation refers to. So the merge
// model, reading A's ledger, knows WHO "B"/"bee" is — a real person object with
// attributes, not a bare name. Resolver is built once per process from the contacts
// table (contacts are static within a run).
let _resolver = null;
function getResolver(cdb) {
  if (_resolver) return _resolver;
  const contacts = cdb.prepare('SELECT file_path, name FROM contacts').all()
    .map((r) => ({ slug: r.file_path ? r.file_path.replace('data/contacts/', '').replace(/\.md$/, '') : null, name: r.name }))
    .filter((c) => c.slug);
  _resolver = buildResolver(contacts);
  return _resolver;
}

// A compact one-line digest of a referenced person's profile — relationship, birthday,
// and their first "What I know" fact (citations stripped). Enough for the model to
// place them; deliberately NOT the whole profile, which would bloat every ledger.
function personDigest(slug, name) {
  let md;
  try { md = fs.readFileSync(path.posix.join(CONTACTS_DIR, `${slug}.md`), 'utf8'); } catch { return null; }
  const field = (label) => {
    const m = md.match(new RegExp(`^\\s*[-*]?\\s*\\*{0,2}${label}:?\\*{0,2}\\s*(.+)$`, 'mi'));
    return m ? m[1].replace(/[*_]/g, '').trim() : null;
  };
  const clean = (v) => (v && !/^_?(unknown|tbd)_?$/i.test(v) ? v : null);
  const rel = clean(field('Relationship'));
  const bday = clean(field('Birthday'));
  const knowSec = (md.split(/^##\s+What I know/mi)[1] || '').split(/^##\s+/m)[0];
  const firstBullet = (knowSec.match(/^[-*]\s+(.+)$/m) || [])[1];
  const bits = [];
  if (rel) bits.push(rel);
  if (bday) bits.push(`b. ${bday}`);
  if (firstBullet) bits.push(firstBullet.replace(/⟨[^⟩]*⟩/g, '').replace(/\s+/g, ' ').trim().slice(0, 140));
  return bits.length ? `${name}: ${bits.join('; ')}` : name;
}

const DAY = 86_400_000;
// INGEST == BACKFILL. Ingest processes everything NOT YET MERGED for a contact,
// oldest-first; a "backfill" is just that on a contact with an empty merge ledger,
// so a fresh backfill is byte-identical to having played the history forward. The
// frontier is the `merged` table (lib/archive.js), not a cursor — see planContact.
//
// The one exception is the eval harness, which passes an explicit backfillDays
// window (evals/cases.js) to hold out a slice of history: a finite backfillDays
// restricts the unmerged set to `sent_at >= now - N days`. CRM_BACKFILL_DAYS forces
// a window by hand if one is ever wanted.
const MERGE_BACKFILL_DAYS = process.env.CRM_BACKFILL_DAYS ? Number(process.env.CRM_BACKFILL_DAYS) : null;

function loadNicknames() {
  try {
    return JSON.parse(fs.readFileSync(DISPLAY_NAMES, 'utf8')).byServiceId || {};
  } catch {
    return {};
  }
}

// ---- planning ------------------------------------------------------------------

// gateBuckets — the ingest decision (BACKFILL == PLAY-IT-FORWARD; see AGENTS.md) —
// lives in lib/weeks.js alongside planChunks and dayNumber, so the cost estimator
// (lib/cost.js) can replay the identical gate instead of guessing. Imported above
// and re-exported below for callers that reach it through the planner.

// Plan one contact: resolve their sources, pull everything NOT YET MERGED for them
// out of the ARCHIVE (never Signal — see crm-archive.js) OLDEST-FIRST, and gate it
// into merge buckets (see lib/weeks gateBuckets). Returns null if the contact has no
// sources, nothing unmerged, or nothing the gate has released yet.
//
// CHRONOLOGICAL + LOSSLESS: the merge frontier is the explicit `merged` table, not a
// rowid watermark, so the backlog is read in sent_at order (profiles build up in the
// order the relationship actually happened) and a late-synced OLD message is picked
// up in its date place instead of being stranded below an advancing cursor. See
// AGENTS.md (BACKFILL == PLAY-IT-FORWARD).
function planContact(cdb, sdb, slug, opts) {
  const { nicks, now, includePartialWeek, backfillDays } = opts;
  const rel = `data/contacts/${slug}.md`;
  const row = cdb.prepare('SELECT signal_id, name FROM contacts WHERE file_path = ?').get(rel);
  if (!row || !row.signal_id) return null;

  const sources = resolveSources(sdb, row.signal_id);

  // Pending = this contact's source messages not yet in the `merged` ledger, read
  // oldest-first. The eval harness may hold out a recent window via backfillDays.
  const notMerged = 'id NOT IN (SELECT message_id FROM merged WHERE slug = ?)';
  const bound = backfillDays != null
    ? { clause: `${notMerged} AND sent_at >= ?`, params: [slug, now - backfillDays * DAY] }
    : { clause: notMerged, params: [slug] };
  const q = buildArchiveQuery(sources, row.signal_id, bound, { orderBy: 'sent_at ASC, id ASC' });
  if (!q) return null;
  const msgs = cdb.prepare(q.sql).all(...q.params);
  if (msgs.length === 0) return null;
  // Fold any OCR/transcript for a message's attachments onto its line (read time),
  // so the merge model reads what a photo said or a voice note contained. Attached
  // now so it rides into every chunk; a no-media message costs nothing.
  for (const m of msgs) m.fold = foldSuffix(cdb, m.att_hashes);

  const display = (nicks[row.signal_id] && nicks[row.signal_id].name) || row.name;
  const cutoff = lastCompleteWeekStart(now);

  // On-demand single-contact runs (includePartialWeek) bypass the gate and fold
  // everything now (still token-batched) — you pressed that button to bring this
  // person fully up to date today. Scheduled runs apply the N/floor/ceiling gate up
  // to the last complete week so no merge ever sees a partial one.
  let bucketMsgs;
  if (includePartialWeek) {
    bucketMsgs = [msgs];
  } else {
    // The gate measures age from each pile's own start (see gateBuckets), so it
    // needs no merge-frontier input — `msgs` (already the unmerged set, oldest-first)
    // is enough. A fresh rebuild gates from the very start of history.
    bucketMsgs = gateBuckets(msgs, {
      N: INGEST_N, floorDays: INGEST_FLOOR_DAYS, ceilingDays: INGEST_CEILING_DAYS,
      endMs: cutoff,
    });
  }
  if (bucketMsgs.length === 0) return null; // gate hasn't opened — retry next run

  // Each released bucket is token-batched into chunks (whole weeks up to 40k tok /
  // 6 weeks — lib/weeks.js defaults). A small bucket is one chunk = one merge; a
  // large one splits so no single merge digests an unreviewable pile.
  const chunks = [];
  for (const bm of bucketMsgs) for (const ch of planChunks(bm)) chunks.push(ch);
  if (chunks.length === 0) return null;

  // Cast of characters: OTHER tracked people these messages refer to (by name or a
  // confirmed nickname), each as a compact profile digest for the ledger header.
  // Excludes the subject (the profile is about them) and Nathan (the reader).
  const cast = [];
  try {
    const resolver = getResolver(cdb);
    const mentioned = new Set();
    for (const bm of bucketMsgs) for (const m of bm) for (const s of resolver.mentionsIn(m.body || '')) mentioned.add(s);
    mentioned.delete(slug);
    mentioned.delete('nathan');
    for (const s of mentioned) {
      const d = personDigest(s, resolver.nameBySlug.get(s) || s);
      if (d) cast.push(d);
    }
  } catch { /* cast is best-effort context */ }

  return {
    slug,
    name: display,
    profile: rel,
    sources,
    total: chunks.reduce((n, c) => n + c.count, 0),
    chunks,
    cast,
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

  const nicks = loadNicknames();
  const plans = [];
  for (const slug of tracked) {
    const p = planContact(cdb, sdb, slug, { nicks, now, includePartialWeek, backfillDays });
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
    // Tag the old bot so the merge reads its lines as automated, not a person.
    const sender = m.src === BOT_SERVICE_ID ? `${m.sender} (bot)` : m.sender;
    return `[${fmtLocal(m.sent_at)}] ⟨m${m.rid}⟩ ${ctx}${sender}: ${redact(m.body)}${m.fold || ''}`;
  });

  const srcBits = [];
  if (plan.sources.dmConvIds.length) srcBits.push('DM');
  for (const cid of [...plan.sources.biGroupConvIds, ...plan.sources.multiGroupConvIds]) {
    if (chunk.msgs.some((m) => m.cid === cid)) srcBits.push(`group "${plan.sources.labels[cid]}"`);
  }

  // KNOWN NICKNAMES (feature 1): give the model the confirmed nicknames of the
  // people it will read about, so a message that addresses someone as "Kat" or
  // "Wayne" resolves to the right person. This is context in the ledger DATA, not a
  // prompt change. Confirmed-only (see lib/nicknames.confirmedNicknames). The subject
  // and Nathan are always relevant; Nathan's are the big win — otherwise the model
  // has no way to know a third party's "Wayne" means Nathan.
  const nickBits = [];
  for (const [who, s] of [[plan.name, plan.slug], ['Nathan', 'nathan']]) {
    const names = confirmedNicknames(s);
    if (names.length) nickBits.push(`${who} is also called ${names.map((n) => `"${n}"`).join(', ')}`);
  }

  // CAST OF CHARACTERS: the other tracked people these messages refer to, each a
  // compact profile digest — so a mention of "B"/"bee" is a real person the model
  // knows (relationship, age, a fact), not a bare name. Context only; the subject is
  // still the one profile being edited.
  const castLines = (plan.cast && plan.cast.length)
    ? ['# people referenced (context — NOT the subject of this profile):', ...plan.cast.map((d) => `#   ${d}`)]
    : [];

  const header = [
    `# Messages with ${plan.name} — ${chunk.label} (Pacific)`,
    `# chunk ${chunkIndex} of ${chunkTotal} · ${chunk.count} messages · ids m${chunk.ridStart}–m${chunk.ridEnd}`,
    `# window: ${fmtLocal(chunk.startMs)} to ${fmtLocal(chunk.endMs)}${chunk.partial ? ' (partial week — oversized week split by day)' : ''}`,
    `# sources: ${srcBits.join(', ') || 'DM'}`,
    ...(nickBits.length ? [`# known nicknames: ${nickBits.join('; ')}`] : []),
    ...castLines,
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
      console.log(`  ${p.slug} (${p.name}): ${p.total} unmerged msg(s) in ${p.chunks.length} chunk(s)`);
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
  // NOTE: planning writes no state — crm-daily records merges in the `merged` table
  // only after each chunk's merge succeeds (crash safety; see header).
}

if (require.main === module) main();
module.exports = { planAll, planContact, gateBuckets, writeChunkLedger, chunkSummary, MERGE_BACKFILL_DAYS };
