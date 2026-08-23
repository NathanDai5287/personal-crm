// crm-timeline.js — INGEST'S TIMELINE STEP: tiered "resolution gradient" memory for
// tracked CRM contacts AND groups. This is not a job of its own — it is the second
// half of ingest (see lib/jobs.js). crm-daily.js drives it once per ingest run
// (forced); it is also runnable standalone from the CLI for one contact/group.
//
// A conversation (a 1:1 DM or a group) keeps its `## Timeline` at decreasing resolution:
//   ### Daily log (7–21 days)        one line per Pacific day (Mon-04:00 anchored)
//   ### Weekly log (3–10 weeks)      one line per Pacific calendar week (Mon 04:00)
//   ### Older                        coarse/era notes (+ any pre-existing curated timeline)
//
// NO verbatim tier. There used to be a "### Recent (raw, last 7 days)" block that
// copied the last week's messages into the profile word-for-word. Nathan's call
// (2026-08-23): "I will never read an exact log of a week's worth of messages …
// I don't want to be reading (or even storing) exact message copies in the
// profiles." So the timeline is summaries only. The most recent ~week is therefore
// NOT in the Timeline (its raw block is gone, and a day is only summarized once it
// has fully aged out, so a partial day is never frozen) — recent substance lives in
// the merge sections (What I know / Talking points). This keeps the timeline free
// of verbatim text AND adds no model cost (the Timeline step runs on a paid model);
// it does not summarize the current week just to fill the gap. The full verbatim
// history always lives in the archive (crm.db); fetch it with crm-transcript.js.
// Contact profiles also get:
//   ### Group activity               folded day-summaries from groups they're in (capped)
//
// Groups are multi-speaker (raw lines labeled by sender) sourced by groupId. When a group's
// day rolls up into a daily summary, that summary is also folded into each tracked
// participant's profile, so a person's profile reflects their group activity too.
//
// The Signal DB stores every message permanently, so the Timeline is always recoverable.
//
// CONTRACT — real by default; --dry-run previews (no writes, no model). Backs up each
// file before writing. First run only sets up structure (no re-summarizing history); the
// gradient builds forward from now. Because Timeline is ingest's step and never a
// scheduled job, it has NO run-toggle of its own — the ingest switch pauses it.
// (`--write` is the old spelling of "apply", now the default, accepted as a silent
// no-op; `--force` is likewise accepted as a no-op, since ingest passes it.)
//
// Usage:
//   node crm-timeline.js                       # apply (default), all tracked contacts + groups
//   node crm-timeline.js --dry-run             # preview only, no writes, no model
//   node crm-timeline.js --slug katia-jacoby   # one contact
//   node crm-timeline.js --group third-woman   # one group
//   node crm-timeline.js --no-llm              # structural only, skip summaries

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { openSignalDb, openCrmDb } = require("../lib/signal-db");
const { render, loadTemplate } = require("../lib/timeline-prompt");
const { runSweep } = require("./crm-archive");
const { resolveSources, groupOthers } = require("../lib/sources");
const { foldSuffix: mediaFold } = require("../lib/media");
const { redact } = require("../lib/redact");
// Pacific, always — see lib/weeks.js header. dateKey/fmtLocal replace this file's old
// getUTC*()-based dayKey/fmtTs (a message at 23:30 Pacific landed on the next UTC day),
// and weekStart/nextWeekStart replace isoWeekKey's UTC-ISO week with the pipeline's own
// Monday-04:00-Pacific week boundary, so the Timeline's tiers bucket the same way every
// other ledger in the system does.
const { dateKey, fmtLocal, weekStart, nextWeekStart, dayStart } = require("../lib/weeks");
const {
  DATA_DIR,
  TRACKED,
  TRACKED_GROUPS,
  CONTACTS_DIR,
  GROUPS_DIR,
  BACKUP_DIR,
  TIMELINE_STATE,
  DISPLAY_NAMES,
  MY_SERVICE_ID,
  BOT_SERVICE_ID,
  PI_CLI,
  TIMELINE_MODEL,
  TIMELINE_PROMPT,
} = require("../lib/config");

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DAILY_FROM_DAYS = 7; // daily tier covers [7, 21) days ago (was the old RAW_DAYS boundary)
const DAILY_UNTIL_DAYS = 21;
const WEEKLY_UNTIL_DAYS = 70;
const GROUP_ACTIVITY_MAX = 40; // cap on folded group-activity lines per contact

const args = process.argv.slice(2);
// STANDARD CONTRACT (see lib/run-toggles.paused): real by default; --dry-run previews.
// `--write` is the old spelling of "apply" and is now the default, so it is a silent no-op.
const DRY_RUN = args.includes("--dry-run");
const WRITE = !DRY_RUN;
const NO_LLM = args.includes("--no-llm");
// --force is accepted as a silent no-op: ingest passes it to its Timeline sub-step
// (there is no toggle here to bypass — see main()).
const FORCE = args.includes("--force"); // eslint-disable-line no-unused-vars
// --backfill: build the Timeline tiers from the WHOLE archived history — one
// weekly summary per complete week from the conversation's first archived
// message — instead of only forward from when tiering started. This is what
// makes a profile backfill equivalent to having run the pipeline all along
// (Nathan's rule). EXPLICIT FLAG ONLY, never inferred from missing state: it
// spends one model call per historical week per conversation, so it must be
// impossible to trigger by accident. Idempotent: filled weekly keys are
// skipped, so re-running only fills gaps.
const BACKFILL = args.includes("--backfill");
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const slugArg = argVal("--slug");
const groupArg = argVal("--group");
// Effective model: an explicit --model (crm-daily passes the ingest run's model) >
// CRM_TIMELINE_MODEL env / default. Timeline is not a UI job, so there is no
// separate dropdown here — ingest's model governs it, passed in via --model.
const TIMELINE_MODEL_EFF = argVal("--model") || TIMELINE_MODEL;


// Replaces the original claude.exe call: invoke `pi` headless, prompt via
// stdin, `pi -p` prints just the response text on stdout. Never throws —
// the Timeline step must never crash the pipeline on a model error.
// Set once per run (in main) to a throwaway session dir under data/ so each
// summary's real pi usage is recorded and can be summed for the "actual" cost in
// the ledger; deleted after the run. null → stay ephemeral (--no-session).
let SESSION_CAPTURE = null;

function piSummarize(prompt, system) {
  if (NO_LLM) return "(summary skipped: --no-llm)";
  try {
    const sessionArgs = SESSION_CAPTURE ? ["--session-dir", SESSION_CAPTURE] : ["--no-session"];
    const argv = [PI_CLI, "-p", ...sessionArgs, "-nc", "--no-extensions", "--no-skills", "--no-tools", "--model", TIMELINE_MODEL_EFF];
    // v1 declares no system prompt — the whole contract sits in the user turn,
    // which was the review's top finding. A variant that declares one gets it
    // on the system channel where models weight it more heavily.
    if (system) argv.push("--system-prompt", system);
    const out = execFileSync(
      process.execPath,
      argv,
      {
        input: prompt,
        cwd: require("os").tmpdir(),
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" },
      },
    );
    return out.trim().replace(/\s+/g, " ") || "(no result)";
  } catch (e) {
    return `(summary failed: ${String(e).slice(0, 80)})`;
  }
}
// The daily/weekly wording lives in CODE, not the template, because the code is
// what knows which bucket it is building. The template decides how to frame it.
// These are prompt v3's style strings (promoted 2026-08-04 with prompts/compact.md;
// evals/compact-run.js STYLE_V1/STYLE_V3 keep per-variant copies so the eval's
// control never silently tracks production): a durability filter with money named
// as durable, a word ceiling well above v2's starvation budget, and
// periods-not-semicolons to kill the clause pileup.
const STYLE_INSTRUCTION = {
  daily: "Summarize the day in ONE line: every durable fact (plans, decisions, life events, money owed or paid) and nothing else — drop chatter, jokes, games, and one-off details that change nothing. Short past-tense sentences separated by periods, not semicolons. At most ~65 words: cut words and noise, never a durable fact.",
  weekly: "Summarize the period in 1-2 lines: the main threads and every durable fact, nothing else. Short past-tense sentences separated by periods, not semicolons. At most ~110 words: cut words and noise, never a durable fact.",
  // era: distills aged-out weekly lines into one season note in the Older tier.
  // Input is weekly SUMMARIES (not raw messages); when the era already has a
  // note it is included in the input and must be rewritten, never appended to.
  // Text reviewed by a Fable agent (2026-08-09): the replace-don't-append and
  // carry-forward-unless-superseded sentences each cover a distinct observed
  // failure mode of repeated self-rewrite; the closing formula is the proven
  // anti-starvation clause from the daily/weekly strings.
  era: "Distill the period into one era note: only what will still matter in a year — life events, durable changes (job, school, moves, relationships), big decisions, money milestones. Drop week-by-week narration and logistics. When a later week changes or reverses an earlier fact, keep only the outcome. If a current era note is included, rewrite the whole note — your output replaces it, never appends to it — and keep every fact it holds unless a later week supersedes it. One paragraph of short past-tense sentences separated by periods, not semicolons. At most ~120 words: cut words and noise, never a durable fact.",
};

// Exported so evals/ can build the exact prompt this pipeline sends without
// re-implementing it — the same reason crm-merge.js takes a promptFile override.
function buildSummaryPrompt(who, periodLabel, lines, style, template) {
  return render(template, {
    // Era calls read weekly summaries, not raw messages — the framing must say so.
    PERIOD_SENTENCE: style === "era"
      ? `These are one-line weekly summaries of Signal messages ${who} during ${periodLabel}.`
      : `These are Signal messages ${who} during ${periodLabel}.`,
    STYLE_INSTRUCTION: STYLE_INSTRUCTION[style] || STYLE_INSTRUCTION.weekly,
    MESSAGES: lines.join("\n"),
  });
}

// piSummarize never throws — it returns a placeholder string on error, on an
// empty model reply, or under --no-llm. Those placeholders must never be stored
// as if they were summaries; see the callers in buildConvTiers.
function isBadSummary(s) {
  return !s || /^\((summary (failed|skipped)|no result)/.test(String(s).trim());
}

let TIMELINE_TEMPLATE = null;
function summarize(who, periodLabel, lines, style) {
  if (lines.length === 0) return null;
  if (TIMELINE_TEMPLATE === null) TIMELINE_TEMPLATE = loadTemplate(TIMELINE_PROMPT);
  const { system, user } = buildSummaryPrompt(who, periodLabel, lines, style, TIMELINE_TEMPLATE);
  return piSummarize(user, system);
}

// ---- timeline block parsing --------------------------------------------------

const TIER_HEADERS = {
  // `raw` is PARSE-ONLY now: renderTimeline no longer emits it, but keeping the
  // header here lets parseTiers still recognize (and thereby DROP) a legacy
  // "### Recent (raw, …)" block left in an old profile, so verbatim message copies
  // clear out on the next run instead of lingering. See the top-of-file note.
  raw: "### Recent (raw, last 7 days)",
  daily: "### Daily log",
  weekly: "### Weekly log",
  older: "### Older",
  group: "### Group activity",
};

// Season eras for the Older tier, Pacific calendar: spring = Jan–May,
// summer = Jun–Aug, fall = Sep–Dec. A week belongs to the era of its Monday.
function eraKey(weekDateKey) {
  const m = Number(weekDateKey.slice(5, 7));
  return `${weekDateKey.slice(0, 4)}-${m <= 5 ? "spring" : m <= 8 ? "summer" : "fall"}`;
}
function eraName(era) {
  const [y, s] = era.split("-");
  return `${s} ${y}`;
}
// Season names don't sort chronologically as text (summer > spring > fall),
// so the Older tier orders by the era's starting month instead.
function eraSortKey(k) {
  return k.replace(/(spring|summer|fall)$/, (s) => ({ spring: "01", summer: "06", fall: "09" }[s]));
}

function splitProfile(text) {
  const lines = text.split("\n");
  const tlIdx = lines.findIndex((l) => /^##\s+Timeline\b/i.test(l));
  if (tlIdx === -1) {
    const openIdx = lines.findIndex((l, i) => i > 0 && /^##\s+Open questions\b/i.test(l));
    if (openIdx >= 0) {
      return {
        head: lines.slice(0, openIdx).join("\n").replace(/\s*$/, "") + "\n\n",
        timelineExisting: "",
        tail: "\n" + lines.slice(openIdx).join("\n"),
      };
    }
    return { head: text.replace(/\s*$/, "") + "\n\n", timelineExisting: "", tail: "" };
  }
  let end = lines.length;
  for (let i = tlIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return {
    head: lines.slice(0, tlIdx).join("\n").replace(/\s*$/, "") + "\n\n",
    timelineExisting: lines.slice(tlIdx + 1, end).join("\n").trim(),
    tail: end < lines.length ? "\n" + lines.slice(end).join("\n") : "",
  };
}

function parseTiers(block) {
  const buckets = { raw: [], daily: [], weekly: [], older: [], group: [] };
  let legacy = [];
  let cur = "legacy";
  for (const line of block.split("\n")) {
    const hit = Object.entries(TIER_HEADERS).find(([, hdr]) => line.trim() === hdr);
    if (hit) {
      cur = hit[0];
      continue;
    }
    (cur === "legacy" ? legacy : buckets[cur]).push(line);
  }
  const toMap = (arr) => {
    const m = new Map();
    for (const l of arr) {
      const mm = l.match(/^- ([0-9]{4}-[0-9A-Za-z-]+):\s*(.*)$/);
      if (mm) m.set(mm[1], mm[2]);
    }
    return m;
  };
  return {
    daily: toMap(buckets.daily),
    weekly: toMap(buckets.weekly),
    older: toMap(buckets.older),
    group: buckets.group.filter((l) => l.trim().startsWith("- ")), // flat capped list
    legacyOlder: legacy.join("\n").trim(),
  };
}

function renderTimeline(t, { includeGroup }) {
  const sortDesc = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const out = ["## Timeline"];
  for (const [tier, label] of [
    ["daily", "daily"],
    ["weekly", "weekly"],
  ]) {
    out.push("", TIER_HEADERS[tier]);
    out.push(t[tier].size ? sortDesc(t[tier]).map(([k, v]) => `- ${k}: ${v}`).join("\n") : "_(none yet)_");
    void label;
  }
  out.push("", TIER_HEADERS.older);
  const olderLines = [...t.older.entries()]
    .sort((a, b) => (eraSortKey(a[0]) < eraSortKey(b[0]) ? 1 : -1))
    .map(([k, v]) => `- ${k}: ${v}`);
  out.push([olderLines.join("\n"), t.legacyOlder].filter(Boolean).join("\n\n").trim() || "_(none yet)_");
  if (includeGroup) {
    out.push("", TIER_HEADERS.group);
    out.push(t.group.length ? t.group.join("\n") : "_(none yet)_");
  }
  return out.join("\n");
}

// ---- DB access ---------------------------------------------------------------

// (Speaker name attribution moved into the archive sweep — see crm-archive.js.)
// Multi-conversation message fetch — FROM THE ARCHIVE (crm.db), not Signal.
// The hourly sweep (crm-archive.js) is the only Signal reader; reading here
// from the archive means timelines keep messages that have since disappeared
// from Signal. `convs` is a list of sources:
//   { convId, prefix, conversation, srcFilter }
//     prefix       -> line prefix for group context, e.g. '(Nat & Kat) '
//     conversation -> human label (informational)
//     srcFilter    -> optional [serviceIds]: keep only these senders
// Speaker labels were attributed once, at archive time (sender column).
// Rows from all sources are merged in time order, so a contact's timeline
// interleaves their DM and their group chats exactly like refresh ledgers do.
function messagesBetween(cdb, convs, fromMs, toMs) {
  const rows = [];
  for (const c of convs) {
    let sql = `SELECT id AS rid, body, sent_at, type, src AS sourceServiceId, sender, att_hashes FROM messages
       WHERE conv_id = ? AND sent_at >= ? AND sent_at < ?`;
    const params = [c.convId, fromMs, toMs];
    if (c.srcFilter && c.srcFilter.length) {
      // Outgoing rows often carry a NULL src, so when the filter includes
      // Nathan (bi-groups: both directions) match his messages by type too —
      // mirrors the bi-group clause in lib/sources.js.
      const srcIn = `src IN (${c.srcFilter.map(() => "?").join(",")})`;
      sql += c.srcFilter.includes(MY_SERVICE_ID) ? ` AND (type = 'outgoing' OR ${srcIn})` : ` AND ${srcIn}`;
      params.push(...c.srcFilter);
    }
    for (const r of cdb.prepare(sql + " ORDER BY sent_at ASC").all(...params)) rows.push({ ...r, _c: c });
  }
  rows.sort((a, b) => a.sent_at - b.sent_at || a.rid - b.rid);
  return {
    lines: rows.map((m) => `[${fmtLocal(m.sent_at)}] ⟨m${m.rid}⟩ ${m._c.prefix || ""}${m.sender}: ${redact((m.body || "").replace(/\s+/g, " ").trim())}${mediaFold(cdb, m.att_hashes)}`),
    senders: new Set(rows.map((r) => r.sourceServiceId).filter(Boolean)),
  };
}

// ---- shared tiering engine ---------------------------------------------------

// The earliest archived message across a conversation's sources — where a
// --backfill starts its weekly walk. Sender filters are deliberately ignored:
// starting a couple of weeks early only adds empty weeks, which cost nothing.
function firstArchivedMs(cdb, convs) {
  let first = null;
  for (const c of convs) {
    const r = cdb.prepare("SELECT MIN(sent_at) AS m FROM messages WHERE conv_id = ?").get(c.convId);
    if (r && r.m != null) first = first == null ? r.m : Math.min(first, r.m);
  }
  return first;
}

// DST-safe Pacific-day stepping. lib/weeks has no prev/next-day primitive, but
// dayStart() re-anchors ANY instant to its 04:00-Pacific day start, so nudging by
// more than the ±1h DST shift and re-anchoring steps whole Pacific days reliably.
const prevDayStart = (ds) => dayStart(ds - 2 * HOUR);
const nextDayStart = (ds) => dayStart(ds + 26 * HOUR);

// The 04:00-Pacific day starts for the daily tier window, index i = i days before
// today (today = index 0). ANCHORED TO THE PACIFIC CALENDAR, not a rolling 24h
// window off Date.now() — so a day's key is the same whether the run fires at 04:00
// or 15:00, and it never skips/collides a date across a DST transition. This is the
// fix for the old `now - (d+1)*DAY` keying.
function dayStartsForDaily(now) {
  const out = [dayStart(now)];
  for (let i = 1; i < DAILY_UNTIL_DAYS; i++) out.push(prevDayStart(out[i - 1]));
  return out;
}

// The Monday-04:00-Pacific week key a daily key ("YYYY-MM-DD") belongs to. Uses a
// mid-day instant (far from any DST edge) so weekStart lands on the correct Monday
// regardless of that date's offset. Lets the daily-deletion rule find a daily's
// week without threading the timestamp through the parsed profile.
function weekKeyOfDay(dayKey) {
  const [y, mo, d] = dayKey.split("-").map(Number);
  return dateKey(weekStart(Date.UTC(y, mo - 1, d, 19, 0)));
}

// Mutates `t` (daily/weekly/older maps). Returns { summaries, attempts,
// newDailies, historyFrom, foldedOut }. `foldedTo` is the era-fold watermark from
// state: every weekly key ≤ it has already been distilled.
function buildConvTiers(cdb, convs, who, since, now, t, foldedTo) {
  let summaries = 0;
  let attempts = 0; // model calls this run WOULD make — the cost preview under --no-llm
  const newDailies = new Map();
  // Daily: ensure a one-line summary for each 04:00-Pacific day in
  // [DAILY_FROM_DAYS, DAILY_UNTIL) that aged out after tiering started. Every day in
  // this window is COMPLETE (the current ~week is excluded, so a partial day is never
  // frozen under its key — and, with the raw tier gone, the recent week simply isn't
  // in the Timeline). Days are anchored to the Pacific calendar (see dayStartsForDaily)
  // so the key and the summarized window match and are stable across run time-of-day
  // and DST.
  const days = dayStartsForDaily(now);
  for (let d = DAILY_FROM_DAYS; d < DAILY_UNTIL_DAYS; d++) {
    const ds = days[d];
    if (ds < since) continue;
    const key = dateKey(ds);
    if (t.daily.has(key) || t.weekly.has(dateKey(weekStart(ds)))) continue;
    const lines = messagesBetween(cdb, convs, ds, nextDayStart(ds)).lines;
    if (lines.length === 0) continue;
    attempts++;
    const s = summarize(who, key, lines, "daily");
    // A failed or skipped summary must NOT be stored. Storing it is permanent:
    // the `t.daily.has(key)` guard above skips any filled key forever, so one
    // transient model error would leave "(summary failed: …)" in the Timeline
    // for good — and the Timeline step is the one whose raw lines get dropped, so
    // there is nothing to regenerate from later. Leaving the key empty means
    // the next run simply retries the day.
    if (isBadSummary(s)) continue;
    t.daily.set(key, s);
    newDailies.set(key, s);
    summaries++;
  }
  // Weekly: roll up whole Monday-04:00-Pacific weeks (lib/weeks.js's own week
  // boundary — not an ISO-UTC week) older than DAILY_UNTIL, up to WEEKLY_UNTIL, then
  // drop aged dailies. nextWeekStart is the only week-stepping primitive lib/weeks.js
  // exports, so walk forward from the oldest candidate week rather than back from now.
  // Keyed by the week's Monday date, so it sorts and reads like the daily keys.
  //
  // ONLY COMPLETE WEEKS. A week straddling dailyBoundary must wait: summarizing a
  // clipped range would freeze under the week's key (`t.weekly.has` skips filled
  // keys forever), and the days clipped off would age out of the daily tier with
  // nowhere to go — silently vanishing from the Timeline.
  const dailyBoundary = now - DAILY_UNTIL_DAYS * DAY;
  const weeklyBoundary = now - WEEKLY_UNTIL_DAYS * DAY;
  // Forward runs walk only the 21–70 day window; a --backfill walks from the
  // first archived message, so every complete historical week gets its line —
  // the same set of weeklies a pipeline running since day one would have built
  // (dailies for fully rolled-up weeks would have been deleted anyway, so a
  // single weekly pass per week reproduces the play-forward end state).
  let historyFrom = null;
  let weeklyFrom = weekStart(weeklyBoundary);
  if (BACKFILL) {
    const first = firstArchivedMs(cdb, convs);
    if (first != null && weekStart(first) < weeklyFrom) weeklyFrom = weekStart(first);
    historyFrom = first;
  }
  for (let wStart = weeklyFrom; nextWeekStart(wStart) <= dailyBoundary; wStart = nextWeekStart(wStart)) {
    if (wStart < since) continue;
    const key = dateKey(wStart);
    if (t.weekly.has(key)) continue;
    const lines = messagesBetween(cdb, convs, wStart, nextWeekStart(wStart)).lines;
    if (lines.length === 0) continue;
    attempts++;
    const wsum = summarize(who, `the week of ${key}`, lines, "weekly");
    if (isBadSummary(wsum)) continue; // same permanence trap as the daily loop
    t.weekly.set(key, wsum);
    summaries++;
  }
  // Delete a daily ONLY once its week actually has a weekly summary. The old rule
  // deleted any daily older than the current weekly window regardless of whether
  // that week was ever summarized — so a first-run straddle week (skipped by the
  // weekly loop's `wStart < since` guard) or a chronically-failing weekly lost its
  // dailies with nowhere for the content to go: a permanent tier hole. Keeping the
  // dailies of an un-summarized week preserves that content until (if ever) its
  // weekly lands; a summarized week's dailies are redundant and dropped.
  for (const k of [...t.daily.keys()]) if (t.weekly.has(weekKeyOfDay(k))) t.daily.delete(k);

  // ---- era fold: weeks aged past the weekly window distill into their
  // season's note in the Older tier. Weekly lines are KEPT (Nathan's rule:
  // every week stays viewable) — the era note is a distillation on top, not a
  // replacement. Eras fold oldest-first and the watermark only advances
  // through successes, so one failed model call simply retries next run
  // without skipping anything. Forward runs fold a week or two at a time into
  // the era's existing note (rewritten, never appended); a backfill hands an
  // era all its weeks in one call.
  let foldedOut = foldedTo || null;
  const weeklyCutoffKey = dateKey(weekStart(weeklyBoundary));
  const foldable = [...t.weekly.keys()]
    .filter((k) => k < weeklyCutoffKey && (!foldedTo || k > foldedTo))
    .sort();
  const byEra = new Map(); // insertion order = chronological (keys sorted above)
  for (const k of foldable) {
    const era = eraKey(k);
    if (!byEra.has(era)) byEra.set(era, []);
    byEra.get(era).push(k);
  }
  for (const [era, weeks] of byEra) {
    const lines = [];
    const cur = t.older.get(era);
    if (cur) lines.push(`Current era note (rewrite it to fold the new weeks in): ${cur}`);
    for (const k of weeks) lines.push(`- week of ${k}: ${t.weekly.get(k)}`);
    attempts++;
    const note = summarize(who, eraName(era), lines, "era");
    if (isBadSummary(note)) break; // watermark stays — this era retries next run
    t.older.set(era, note.trim());
    summaries++;
    foldedOut = weeks[weeks.length - 1];
  }

  return { summaries, attempts, newDailies, historyFrom, foldedOut };
}

function backupAndWrite(file, next) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(file, `${BACKUP_DIR}/${path.basename(file)}.${Date.now()}.bak`);
  fs.writeFileSync(file, next);
}

// ---- contact + group Timeline builders ----------------------------------------

function buildConversationTimeline({ cdb, convs, who, file, stateKey, state, now, includeGroup, foldLines }) {
  const ensured = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8")
    : `# ${path.basename(file, ".md")}\n\n## What I know\n\n_(stub)_\n`;
  const { head, timelineExisting, tail } = splitProfile(ensured);
  const t = parseTiers(timelineExisting);
  const prevSince = state[stateKey] && state[stateKey].since != null ? state[stateKey].since : null;
  // A backfill owns all of history: no skip guard, and the recorded `since`
  // moves back to the first archived message so future forward runs know the
  // gradient behind them is real, not a gap.
  const since = BACKFILL ? 0 : (prevSince != null ? prevSince : now);

  const foldedTo = (state[stateKey] && state[stateKey].foldedTo) || null;
  const { summaries, attempts, newDailies, historyFrom, foldedOut } =
    buildConvTiers(cdb, convs, who, since, now, t, foldedTo);
  const sinceOut = BACKFILL
    ? Math.min(historyFrom != null ? historyFrom : now, prevSince != null ? prevSince : now)
    : since;

  // Merge folded group-activity lines (newest first, capped). When the cap drops
  // lines, leave a marker so the truncation is visible (the fuller history lives in
  // each group's own timeline). Strip any prior marker first so it can't accumulate.
  const GROUP_TRUNC = 'older group-activity lines omitted — see the group’s own timeline';
  if (includeGroup) {
    t.group = t.group.filter((l) => !l.includes(GROUP_TRUNC));
    const combined = foldLines && foldLines.length ? [...foldLines, ...t.group] : t.group;
    t.group = combined.slice(0, GROUP_ACTIVITY_MAX);
    if (combined.length > GROUP_ACTIVITY_MAX) {
      t.group.push(`- _(${combined.length - GROUP_ACTIVITY_MAX} ${GROUP_TRUNC})_`);
    }
  }

  const newTimeline = renderTimeline(t, { includeGroup });
  const next = `${head}${newTimeline}${tail}`.replace(/\s*$/, "") + "\n";
  const changed = !fs.existsSync(file) || next !== ensured;
  if (changed && WRITE) {
    if (fs.existsSync(file)) backupAndWrite(file, next);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next);
    }
  }
  return { changed, summaries, attempts, since: sinceOut, foldedTo: foldedOut, next, newDailies };
}

function buildContactTimeline(cdb, sdb, slug, state, now, foldLines, nicks) {
  const rel = `data/contacts/${slug}.md`;
  const row = cdb.prepare("SELECT signal_id, name FROM contacts WHERE file_path = ?").get(rel);
  if (!row || !row.signal_id) return { slug, skipped: "no crm row" };
  const display = (nicks[row.signal_id] && nicks[row.signal_id].name) || row.name;

  // Same source universe as crm-refresh.js: DM (all messages), bi-groups
  // (both directions — effectively private channels), multi-groups (only the
  // contact's own messages). Timeline tiers interleave all of them by time.
  // Speaker labels come from the archive's sender column (set at sweep time).
  const sources = resolveSources(sdb, row.signal_id);
  const convs = [
    ...sources.dmConvIds.map((id) => ({
      convId: id, prefix: "", conversation: `DM with ${display}`,
    })),
    ...sources.biGroupConvIds.map((id) => ({
      convId: id, prefix: `(${sources.labels[id]}) `, conversation: sources.labels[id],
      // ALL of this person's identities, not just the canonical one — a
      // re-registered contact's group lines carry an alias src (see lib/sources).
      srcFilter: [MY_SERVICE_ID, ...sources.allIds],
    })),
    ...sources.multiGroupConvIds.map((id) => ({
      convId: id, prefix: `(${sources.labels[id]}) `, conversation: sources.labels[id],
      srcFilter: [...sources.allIds],
    })),
  ];
  if (convs.length === 0) return { slug, skipped: "no conversations" };

  const r = buildConversationTimeline({
    cdb,
    convs,
    who: `between Nathan and ${display}`,
    file: `${CONTACTS_DIR}/${slug}.md`,
    stateKey: slug,
    state,
    now,
    includeGroup: true,
    foldLines,
  });
  return { slug, name: display, ...r };
}

function buildGroupTimeline(cdb, sdb, group, state, now) {
  const conv = sdb.prepare("SELECT id, members FROM conversations WHERE groupId = ? LIMIT 1").get([group.groupId]);
  if (!conv) return { slug: group.slug, skipped: "no group conversation" };
  // Speaker labels (incl. 'Janet' for the old bot) come from the archive's
  // sender column, attributed by the sweep with the full group name map.
  const convSpec = { convId: conv.id, prefix: "", conversation: group.name };
  const r = buildConversationTimeline({
    cdb,
    convs: [convSpec],
    who: `in the group "${group.name}"`,
    file: `${GROUPS_DIR}/${group.slug}.md`,
    stateKey: `group:${group.slug}`,
    state,
    now,
    includeGroup: false,
  });
  // Bi-groups (only other party besides me/bot is one person) are already
  // covered IN that person's own timeline via buildContactTimeline's sources — do
  // not also fold their day-summaries into the profile, or everything would
  // appear twice.
  if (groupOthers(conv.members).length <= 1) {
    return { slug: group.slug, name: group.name, participants: [], ...r };
  }
  // Map participants (tracked contacts who spoke recently) for folding.
  const recent = messagesBetween(cdb, [convSpec], now - DAILY_UNTIL_DAYS * DAY, now).senders;
  const participants = [];
  for (const sid of recent) {
    if (sid === BOT_SERVICE_ID) continue;
    const c = cdb.prepare("SELECT file_path FROM contacts WHERE signal_id = ?").get(sid);
    if (c && c.file_path && c.file_path.startsWith("data/contacts/")) {
      const pslug = c.file_path.replace("data/contacts/", "").replace(/\.md$/, "");
      // Don't fold group activity into the owner's own profile.
      if (pslug !== "nathan") participants.push(pslug);
    }
  }
  return { slug: group.slug, name: group.name, participants, ...r };
}

// The tracked MULTI-groups a contact belongs to. A per-contact run (--slug, and
// the web "Ingest", which passes --slug) processes these in Phase 1 so the
// contact's "Group activity" fold is refreshed — otherwise it only ever updated on
// a full all-contacts run. Cost-neutral: a group day is summarized once (idempotent
// keys), so whoever ingests first that week pays and everyone else skips. Bi-groups
// are excluded: they don't fold (their content is already in the contact's own
// timeline), so processing them in a per-contact run would be pure overhead.
function groupsForContact(sdb, cdb, slug, allGroups) {
  const rel = `data/contacts/${slug}.md`;
  const row = cdb.prepare("SELECT signal_id FROM contacts WHERE file_path = ?").get(rel);
  if (!row || !row.signal_id) return [];
  const sources = resolveSources(sdb, row.signal_id);
  const convIds = new Set(sources.multiGroupConvIds);
  if (!convIds.size) return [];
  return allGroups.filter((g) => {
    const conv = sdb.prepare("SELECT id FROM conversations WHERE groupId = ? LIMIT 1").get([g.groupId]);
    return conv && convIds.has(conv.id);
  });
}

// ---- main --------------------------------------------------------------------

function main() {
  const now = Date.now();
  // NO RUN-TOGGLE GATE HERE. Timeline is not a job (see lib/jobs.js) — it is
  // ingest's second half. Ingest's own switch (checked in crm-daily.js) already
  // decides whether the weekly run happens; a standalone `node crm-timeline.js`
  // is always a deliberate CLI invocation. So there is nothing to pause here.
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(TIMELINE_STATE, "utf8"));
  } catch {}
  const nicks = (() => {
    try {
      return JSON.parse(fs.readFileSync(DISPLAY_NAMES, "utf8")).byServiceId || {};
    } catch {
      return {};
    }
  })();
  const cdb = openCrmDb();
  const sdb = openSignalDb();
  // ARCHIVE-FIRST: pull anything new into the archive, then read all message
  // content from it (Signal is only consulted for conversation metadata).
  runSweep(cdb, sdb);

  const allGroups = (() => {
    try {
      return JSON.parse(fs.readFileSync(TRACKED_GROUPS, "utf8")).groups || [];
    } catch {
      return [];
    }
  })();
  // A --slug run also processes that contact's multi-groups (Phase 1) so their
  // "Group activity" fold stays current — not only on a full all-contacts run.
  const groups = groupArg
    ? allGroups.filter((g) => g.slug === groupArg)
    : slugArg
      ? groupsForContact(sdb, cdb, slugArg, allGroups)
      : allGroups;
  const slugs = groupArg ? [] : slugArg ? [slugArg] : JSON.parse(fs.readFileSync(TRACKED, "utf8")).slugs;

  console.log(`crm-timeline: ${WRITE ? "WRITE" : "DRY-RUN"}${NO_LLM ? " | --no-llm" : ""}${BACKFILL ? " | BACKFILL (whole history)" : ""} | ${slugs.length} contact(s), ${groups.length} group(s)\n`);

  // Tallies for the /admin/runs ledger: how many conversations were processed
  // (not skipped), how many had their profile changed, and total summary lines.
  let scanned = 0;
  let changedCount = 0;
  let summariesCount = 0;

  // ACTUAL-COST CAPTURE: point every summary call at one throwaway session dir
  // under data/ (gitignored, deleted below) so pi records real usage we can sum.
  // Only when we'll actually call the model and write a ledger row.
  if (WRITE && !NO_LLM) {
    try {
      const base = path.join(DATA_DIR, "_session-tmp");
      fs.mkdirSync(base, { recursive: true });
      SESSION_CAPTURE = fs.mkdtempSync(path.join(base, "c-"));
    } catch { SESSION_CAPTURE = null; }
  }

  // Phase 1: groups first, so their new day-summaries can fold into participant profiles.
  const foldByContact = new Map(); // slug -> [ "- YYYY-MM-DD [Group]: summary", ... ]
  for (const g of groups) {
    const r = buildGroupTimeline(cdb, sdb, g, state, now);
    if (r.skipped) {
      console.log(`- group ${g.slug}: skipped (${r.skipped})`);
      continue;
    }
    scanned += 1;
    if (r.changed) changedCount += 1;
    summariesCount += r.summaries || 0;
    console.log(`- group ${g.slug} (${r.name}): summaries=${r.summaries}/${r.attempts} participants=[${r.participants.join(", ")}] changed=${r.changed}`);
    if (WRITE) state[`group:${g.slug}`] = { since: r.since, foldedTo: r.foldedTo || undefined, ranAt: now };
    for (const [date, summary] of r.newDailies || []) {
      const line = `- ${date} [${r.name}]: ${summary}`;
      for (const slug of r.participants) {
        if (!foldByContact.has(slug)) foldByContact.set(slug, []);
        foldByContact.get(slug).push(line);
      }
    }
    if (!WRITE && r.next && groupArg) printTimeline(r.next);
  }

  // Phase 2: contacts (with any folded group activity).
  for (const slug of slugs) {
    const r = buildContactTimeline(cdb, sdb, slug, state, now, foldByContact.get(slug) || [], nicks);
    if (r.skipped) {
      console.log(`- ${slug}: skipped (${r.skipped})`);
      continue;
    }
    scanned += 1;
    if (r.changed) changedCount += 1;
    summariesCount += r.summaries || 0;
    console.log(`- ${slug} (${r.name}): summaries=${r.summaries}/${r.attempts} changed=${r.changed}`);
    if (WRITE) state[slug] = { since: r.since, foldedTo: r.foldedTo || undefined, ranAt: now };
    if (!WRITE && r.next && slugArg) printTimeline(r.next);
  }

  sdb.close();
  cdb.close();
  if (WRITE) fs.writeFileSync(TIMELINE_STATE, JSON.stringify(state, null, 2));

  // Record real (write) passes in the /admin/runs ledger. Dry-runs are
  // inspections, not passes, so they leave no row — matching crm-daily, which
  // also skips the ledger on --dry-run. Non-fatal: a failed record must never
  // fail the Timeline pass it describes.
  if (WRITE) {
    const endedAt = Date.now();
    // Estimated Timeline spend: one model call per summary line written. Estimate
    // only (see lib/cost.js) — null if TIMELINE_MODEL isn't in pi's price catalog.
    let costUsd = null;
    let actualCostUsd = null;
    try {
      const cost = require("../lib/cost");
      const per = cost.shortCallUsd(TIMELINE_MODEL_EFF);
      costUsd = per == null ? null : per * summariesCount;
      // Real billed cost, summed from the session dir every summary wrote into.
      if (SESSION_CAPTURE) {
        const a = cost.sumSessionCostUsd(SESSION_CAPTURE);
        if (a) actualCostUsd = a.costUsd;
      }
    } catch { /* pricing is best-effort */ }
    try {
      require("../lib/run-record").writeRunRecord({
        kind: "timeline",
        startedAt: now,
        endedAt,
        durationMs: endedAt - now,
        only: slugArg || (groupArg ? `group:${groupArg}` : null),
        scanned,
        changed: changedCount,
        summaries: summariesCount,
        costUsd,
        actualCostUsd,
        costModel: TIMELINE_MODEL_EFF,
      });
    } catch (e) {
      console.log(`crm-timeline: run-record not written (non-fatal): ${e.message}`);
    }
  }
  // Delete the throwaway capture dir — nothing accumulates outside a single run.
  if (SESSION_CAPTURE) {
    try { fs.rmSync(SESSION_CAPTURE, { recursive: true, force: true }); } catch { /* best-effort */ }
    SESSION_CAPTURE = null;
  }
}

function printTimeline(next) {
  const m = next.match(/## Timeline[\s\S]*?(?=\n## |$)/);
  console.log("\n----- proposed Timeline (dry-run) -----\n");
  console.log(m ? m[0] : next);
  console.log("\n----- end -----");
}

// Pure tiering helpers exposed for evals/timeline-tiers-selftest.js. Requiring this
// module does not run main() (guarded below), so the test can import these directly.
module.exports = { dayStartsForDaily, weekKeyOfDay, prevDayStart, nextDayStart };

if (require.main === module) {
  // Cross-process pipeline lock (see lib/pipeline-lock.js). The Timeline step
  // rewrites profiles and runs a sweep first, so it must not overlap another run.
  const lock = require('../lib/pipeline-lock').acquire('timeline');
  if (!lock.ok) { console.log(`crm-timeline: skipped, run in progress (${lock.holderDesc}).`); process.exit(0); }
  try { main(); } finally { lock.release(); }
}
