'use strict';
// weeks.js — week-aligned chunking for the CRM pipeline.
//
// THE INVARIANT: every scheduled merge sees WHOLE WEEKS of messages, never a
// fragment of one. A week runs Monday 04:00 America/Los_Angeles to the next
// Monday 04:00. The weekly pipeline fires at Monday 04:00, so each run picks up
// exactly the week that just closed.
//
// WHY THIS EXISTS: a backfill and a steady-state run are now the same operation.
// A contact with a year of unmerged history is just N sequential weekly merges;
// there is no separate "backfill mode" and no ledger large enough to overflow a
// context window. It also means a failure costs one chunk, not one contact.
//
// BATCHING: one merge per week would be enormously wasteful — most contacts have
// weeks with a couple dozen messages, and every merge pays the same fixed cost
// (system prompt, tool schemas, the whole profile re-sent, several edit turns).
// So consecutive QUIET weeks are batched together until the chunk approaches a
// token ceiling. Chunks always begin and end on a Monday-04:00 boundary; batching
// never splits a week, it only groups whole ones.
//
// Batching is by ESTIMATED TOKENS, not message count: message length varies ~2.4x
// across contacts (24 chars/msg for one, 57 for another), so a count threshold is
// a poor proxy for the thing that actually constrains us. A max-span cap runs
// alongside it, because a pure size rule will happily glue four months of a quiet
// friendship into one chunk and ask a single merge to digest it as "what's new".
//
// TIMEZONE: all boundaries and all rendered timestamps are America/Los_Angeles,
// computed via Intl rather than the host clock, so behaviour does not change if
// the machine's timezone does. DST is handled — a week is 167 or 169 hours twice
// a year and the arithmetic below accounts for it.

const TZ = 'America/Los_Angeles';
const ANCHOR_HOUR = 4; // weeks (and "days", when sub-splitting) start at 04:00
const DAY = 86_400_000;
const HOUR = 3_600_000;

// Chunking defaults. See planChunks() for how each is applied.
const MAX_TOKENS = 40_000;    // soft ceiling: close a chunk BEFORE breaching this
const MAX_WEEKS = 6;          // hard cap on how many weeks one chunk may span
// A SINGLE week over this gets sub-split by day so no one merge digests an
// oversized, unreviewable pile. Held at MAX_TOKENS: quiet weeks batch UP TO 40k,
// and any week that alone exceeds 40k is broken into day-aligned pieces each under
// 40k — so no chunk (bar a single >40k day, which can't be split further) breaches
// the ceiling. (Was 150k on the assumption no week got that big; hyperactive
// contacts like Katia hit ~110k/week, so that left 110k single-merge chunks.)
const SPLIT_TOKENS = MAX_TOKENS;

// Ledger line overhead: "[YYYY-MM-DD HH:MM] ⟨mNNNNN⟩ (chat) Speaker: " ≈ 41 chars.
// 2.4 chars/token reflects how token-dense this format is (timestamps and ids
// tokenize badly), and is calibrated against real ledgers rather than the usual
// ~4 chars/token prose figure.
const LINE_OVERHEAD_CHARS = 41;
const CHARS_PER_TOKEN = 2.4;

// ---- timezone primitives -------------------------------------------------------

const DTF = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// Wall-clock parts of an instant, in TZ.
function parts(ms) {
  const o = {};
  for (const p of DTF.formatToParts(ms)) if (p.type !== 'literal') o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

// TZ's UTC offset at a given instant, in ms (negative west of Greenwich).
function offsetMs(ms) {
  const p = parts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - (ms - (ms % 1000));
}

// Inverse of parts(): the instant at which TZ's wall clock reads this local time.
// Two-pass because the offset depends on the answer (DST); the second pass fixes
// the boundary cases where the guess landed on the wrong side of a transition.
function zonedToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const ts = guess - offsetMs(guess);
  return guess - offsetMs(ts);
}

function pad(n) { return String(n).padStart(2, '0'); }

// "YYYY-MM-DD HH:MM" in Pacific — the ledger timestamp format.
function fmtLocal(ms) {
  const p = parts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

// "YYYY-MM-DD" in Pacific.
function dateKey(ms) {
  const p = parts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

// ---- week boundaries -----------------------------------------------------------

// Start of the Monday-04:00-Pacific week containing `ms`.
function weekStart(ms) {
  const p = parts(ms);
  // Treat the Pacific wall clock as if it were UTC purely to do day arithmetic,
  // shifted back by ANCHOR_HOUR so that 00:00–03:59 belongs to the previous day.
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - ANCHOR_HOUR * HOUR;
  const dow = (new Date(wall).getUTCDay() + 6) % 7; // 0 = Monday
  const mon = new Date(wall - dow * DAY);
  return zonedToUtc(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate(), ANCHOR_HOUR, 0);
}

// The following week's start. Adding 7*DAY directly would drift across a DST
// transition, so we land mid-week and snap.
function nextWeekStart(ws) { return weekStart(ws + 7 * DAY + 12 * HOUR); }

// Start of the 04:00-anchored Pacific day containing `ms` (used when sub-splitting
// an oversized week).
function dayStart(ms) {
  const p = parts(ms);
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - ANCHOR_HOUR * HOUR;
  const d = new Date(wall);
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), ANCHOR_HOUR, 0);
}

// Absolute integer index of the 04:00-anchored Pacific day containing `ms`
// (00:00–03:59 belong to the previous day, matching weekStart/dayStart). Counts
// whole calendar days since the epoch, so it is DST-safe and — crucially —
// ABSOLUTE: the same instant yields the same number no matter what other messages
// share the batch. gateBuckets measures `age` as a difference of these, so a
// one-shot backfill and a day-by-day replay compute identical ages (a base-
// relative index would drift by a day at the 04:00/DST offset). Adjacent Pacific
// days always differ by exactly 1.
function dayNumber(ms) {
  const p = parts(ms);
  const shift = p.h < ANCHOR_HOUR ? -1 : 0;
  return Math.round(Date.UTC(p.y, p.mo - 1, p.d + shift) / DAY);
}

// Everything strictly before this instant belongs to a COMPLETE week. Scheduled
// runs clamp to it so no merge ever sees a partial week.
function lastCompleteWeekStart(now = Date.now()) { return weekStart(now); }

// The next instant Pacific wall-clock reads hour:minute (for daily-scheduled jobs,
// e.g. the 03:00 deep sweep). If today's time has already passed, returns
// tomorrow's. DST-correct via zonedToUtc.
function nextPacificDaily(hour, minute = 0, now = Date.now()) {
  const p = parts(now);
  let cand = zonedToUtc(p.y, p.mo, p.d, hour, minute);
  if (cand <= now) { const t = parts(now + DAY); cand = zonedToUtc(t.y, t.mo, t.d, hour, minute); }
  return cand;
}

// ---- token estimation ----------------------------------------------------------

function estTokens(msgs) {
  let chars = 0;
  for (const m of msgs) chars += (m.body ? m.body.length : 0) + LINE_OVERHEAD_CHARS;
  return Math.round(chars / CHARS_PER_TOKEN);
}

// ---- chunk planning ------------------------------------------------------------

function makeChunk(startMs, endMs, msgs, partial) {
  let ridStart = Infinity, ridEnd = -Infinity;
  for (const m of msgs) {
    if (m.rid < ridStart) ridStart = m.rid;
    if (m.rid > ridEnd) ridEnd = m.rid;
  }
  return {
    startMs,
    endMs,
    startKey: dateKey(startMs),
    endKey: dateKey(endMs - 1), // inclusive last day, for human-readable labels
    label: dateKey(startMs) === dateKey(endMs - 1)
      ? dateKey(startMs)
      : `${dateKey(startMs)}..${dateKey(endMs - 1)}`,
    msgs,
    count: msgs.length,
    tokens: estTokens(msgs),
    ridStart,
    ridEnd,
    partial: Boolean(partial), // true = a sub-split of one oversized week
  };
}

// An oversized single week, broken into day-aligned pieces under the ceiling.
// Never fires on any week in the current archive; it exists so one runaway week
// can never wedge the pipeline.
function splitWeekByDay(weekMsgs, maxTokens) {
  const byDay = new Map();
  for (const m of weekMsgs) {
    const ds = dayStart(m.sent_at);
    if (!byDay.has(ds)) byDay.set(ds, []);
    byDay.get(ds).push(m);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  const out = [];
  let acc = [], accTok = 0, accStart = null, accEnd = null;
  const flush = () => {
    if (acc.length) out.push(makeChunk(accStart, accEnd, acc, true));
    acc = []; accTok = 0; accStart = null; accEnd = null;
  };
  for (const [ds, list] of days) {
    const tok = estTokens(list);
    if (acc.length && accTok + tok > maxTokens) flush();
    if (!acc.length) accStart = ds;
    acc = acc.concat(list);
    accTok += tok;
    accEnd = ds + DAY;
  }
  flush();
  return out;
}

// Group messages (any order) into week-aligned chunks.
//
// Rules, in priority order:
//   1. A single week over `splitTokens` is sub-split by day and stands alone.
//   2. Otherwise consecutive weeks accumulate until adding the NEXT week would
//      breach `maxTokens` (look-ahead — the chunk closes BEFORE breaching rather
//      than overshooting) or would exceed `maxWeeks` of span.
//   3. Chunk boundaries are always Monday 04:00 Pacific.
//
// Weeks with no messages are simply absent; a chunk's span may therefore cover
// silent weeks between two active ones, which is correct — nothing happened.
function planChunks(msgs, opts = {}) {
  const maxTokens = opts.maxTokens ?? MAX_TOKENS;
  const maxWeeks = opts.maxWeeks ?? MAX_WEEKS;
  const splitTokens = opts.splitTokens ?? SPLIT_TOKENS;
  if (!msgs || msgs.length === 0) return [];

  const byWeek = new Map();
  for (const m of msgs) {
    const ws = weekStart(m.sent_at);
    if (!byWeek.has(ws)) byWeek.set(ws, []);
    byWeek.get(ws).push(m);
  }
  const weeks = [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ws, list]) => ({
      ws,
      list: list.slice().sort((a, b) => a.rid - b.rid),
      tok: estTokens(list),
    }));

  const out = [];
  let acc = [], accTok = 0, accCount = 0, accStart = null, accEnd = null;
  const flush = () => {
    if (acc.length) out.push(makeChunk(accStart, accEnd, acc, false));
    acc = []; accTok = 0; accCount = 0; accStart = null; accEnd = null;
  };

  for (const w of weeks) {
    if (w.tok > splitTokens) {
      flush();
      for (const sub of splitWeekByDay(w.list, maxTokens)) out.push(sub);
      continue;
    }
    if (acc.length && (accTok + w.tok > maxTokens || accCount + 1 > maxWeeks)) flush();
    if (!acc.length) accStart = w.ws;
    acc = acc.concat(w.list);
    accTok += w.tok;
    accCount += 1;
    accEnd = nextWeekStart(w.ws);
  }
  flush();
  return out;
}

// ---- gated ingest cadence ------------------------------------------------------

// GATED BUCKETING — the ingest decision (which lives in the planner, not the cron).
//
// BACKFILL == PLAY-IT-FORWARD is the governing invariant (see AGENTS.md): one
// from-scratch pass must emit the byte-identical bucket sequence the day-by-day
// cron would, so ingest is a pure function of (archive, cursor), never of WHEN the
// cron happened to run. Two properties make that hold:
//
//   1) FOLD IN ROWID ORDER, not by calendar day. A fired bucket is therefore a
//      rowid-CONTIGUOUS prefix of the backlog — exactly what the single rowid cursor
//      can represent. Grouping by day instead (an earlier design) let a late-synced
//      message — old sent_at but high rowid, ~2% of real traffic — strand a
//      low-rowid row below the advancing max-rowid cursor, losing it forever. Rowid
//      order is the observation order; a prefix of it is always safe to mark "done".
//   2) The age clock is a pure function of the cursor. `last` is the max Pacific day
//      over everything merged so far, which the live path reconstructs exactly as
//      MAX(sent_at) WHERE id <= cursor (see crm-refresh planContact). A resumed run
//      therefore starts the identical clock a one-shot backfill had at that rowid.
//
// THE GATE: pile rows up; release a bucket once `age` (days since the last merge)
// reaches the ceiling, or reaches the floor with >= N rows piled. `age` runs from
// `last` to the running max day, so a same-day burst still waits out the floor.
// Rows in the current INCOMPLETE week (day >= endMs's day) are never released — the
// walk stops at the first one — so no merge sees a partial week and the cursor can't
// advance into it. A final check flushes a silent backlog that has aged past the
// gate with no new message to trip it. Days are 04:00-Pacific (dayNumber), DST-safe
// and absolute (identical index for an instant regardless of the batch).
//   lastMergeMs: max sent_at over everything already merged (id <= cursor), or null
//     for a fresh contact (clock starts at the first row's day).
//   endMs: the effective "now" (last complete week); its day bounds what is
//     releasable and drives the silent-backlog ceiling.
function gateBuckets(msgs, { N, floorDays, ceilingDays, lastMergeMs, endMs }) {
  if (!msgs.length) return [];
  const cutoffDay = dayNumber(endMs); // current incomplete week — never release >= this
  let last = lastMergeMs != null ? dayNumber(lastMergeMs) : dayNumber(msgs[0].sent_at);
  let running = last;
  const buckets = [];
  let bl = [];
  for (const m of msgs) { // msgs are rowid-ascending (buildArchiveQuery ORDER BY id ASC)
    const d = dayNumber(m.sent_at);
    if (d >= cutoffDay) break; // reached the incomplete week; defer it and everything after
    // FIRE-BEFORE-ADD: test the pile against `m`'s arrival day, then release it
    // WITHOUT `m`. The released bucket therefore ends on a whole day strictly before
    // the trigger, so a one-shot backfill (which sees every day as complete) and an
    // early live run (for which the trigger's week is still open) cut the bucket at
    // the identical row. `last` becomes the max day already merged — the value the
    // live path reconstructs from the cursor — never the trigger's day.
    if (bl.length) {
      const effDay = d > running ? d : running;
      const age = effDay - last;
      if (age >= ceilingDays || (age >= floorDays && bl.length >= N)) {
        buckets.push(bl);
        last = running;
        bl = [];
      }
    }
    bl.push(m);
    if (d > running) running = d;
  }
  if (bl.length) { // silent/partial pile: force it only if it has actually aged past the gate
    const age = cutoffDay - last;
    if (age >= ceilingDays || (age >= floorDays && bl.length >= N)) buckets.push(bl);
  }
  return buckets;
}

module.exports = {
  TZ, ANCHOR_HOUR, MAX_TOKENS, MAX_WEEKS, SPLIT_TOKENS,
  fmtLocal, dateKey,
  weekStart, nextWeekStart, dayStart, dayNumber, lastCompleteWeekStart, nextPacificDaily,
  estTokens, planChunks, gateBuckets,
};
