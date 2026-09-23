// crm-timeline.js — INGEST'S TIMELINE STEP: tiered "resolution gradient" memory for
// tracked CRM contacts AND groups. This is not a job of its own — it is the second
// half of ingest (see lib/jobs.js). crm-daily.js drives it once per ingest run
// (forced); it is also runnable standalone from the CLI for one contact/group.
//
// A conversation (a 1:1 DM or a group) keeps its `## Timeline` at decreasing resolution:
//   ### Weekly log                   one line per Pacific calendar week (Mon 04:00), written
//                                    once the week has ended ≥7 days ago, from RAW messages
//   ### Monthly log                  one note per calendar month, distilled ONCE from that
//                                    month's weekly lines when it is fully older than ~70 days
//   ### Older                        legacy only: pre-existing curated text, plus old season
//                                    "era" notes not yet superseded by month notes
//
// WEEK → MONTH (Nathan, 2026-09-22). There used to be a daily tier (one line per day
// 7–21 days back) and season era notes. The daily tier read the raw messages, then was
// discarded once the weekly line re-read the SAME raw messages — pure duplicate spend —
// and eras re-wrote their note on every fold. Now raw messages are read once (weekly) and
// a month is one call over 4–5 weekly lines. Weekly lines are still KEPT forever (Nathan's
// rule: every week stays viewable); the month note is a summary on top. Legacy daily lines
// in old profiles are kept until their week gets its weekly line, then dropped (as before);
// a season era note is dropped once every month of that season with weekly lines has a
// month note (a season with no weekly lines keeps its era note — it may be the only record).
//
// NO verbatim tier. There used to be a "### Recent (raw, last 7 days)" block that
// copied the last week's messages into the profile word-for-word. Nathan's call
// (2026-08-23): "I will never read an exact log of a week's worth of messages …
// I don't want to be reading (or even storing) exact message copies in the
// profiles." So the timeline is summaries only. The most recent ~week is therefore
// NOT in the Timeline (its raw block is gone, and a week is only summarized once it
// has fully aged out, so a partial week is never frozen) — recent substance lives in
// the merge sections (What I know / Talking points). This keeps the timeline free
// of verbatim text AND adds no model cost (the Timeline step runs on a paid model);
// it does not summarize the current week just to fill the gap. The full verbatim
// history always lives in the archive (crm.db); fetch it with crm-transcript.js.
// Contact profiles also get:
//   ### Group activity               folded weekly summaries from groups they're in (capped)
//
// Groups are multi-speaker (raw lines labeled by sender) sourced by groupId. When a group's
// week rolls up into a weekly summary, that summary is also folded into the profile of each
// tracked participant who spoke that week, so a person's profile reflects their group
// activity too.
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
//   node crm-timeline.js --self-model <id>     # also build Nathan's own Timeline (lib/self.js)
//                                              # on that model; with --slug nathan, only his
//
// NATHAN'S OWN TIMELINE (lib/self.js) is the same tier engine over EVERY archived
// conversation, with its own template (prompts/self-compact.md) and its own model. Its raw
// input is GROUPED BY CONVERSATION (one block per chat, blank line between blocks, every
// line labelled `(DM: Name)` / `(<group>)`), which is the shape that template documents.
// It runs only when crm-daily passes --self-model (i.e. a self model is chosen in the UI).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { openSignalDb, openCrmDb } = require("../lib/signal-db");
const { signalNameMap } = require("../lib/signal-names");
const { render, loadTemplate } = require("../lib/timeline-prompt");
const { runSweep } = require("./crm-archive");
const { resolveSources, groupOthers } = require("../lib/sources");
const { renderedBody, formatLine, forModel } = require("../lib/message-context");
// Pacific, always — see lib/weeks.js header. dateKey/fmtLocal replace this file's old
// getUTC*()-based dayKey/fmtTs (a message at 23:30 Pacific landed on the next UTC day),
// and weekStart/nextWeekStart replace isoWeekKey's UTC-ISO week with the pipeline's own
// Monday-04:00-Pacific week boundary, so the Timeline's tiers bucket the same way every
// other ledger in the system does.
const { dateKey, fmtLocal, weekStart, nextWeekStart } = require("../lib/weeks");
const { writeJsonAtomic } = require("../lib/atomic-write");
const {
  DATA_DIR,
  TRACKED,
  TRACKED_GROUPS,
  CONTACTS_DIR,
  GROUPS_DIR,
  BACKUP_DIR,
  TIMELINE_STATE,

  MY_SERVICE_ID,
  BOT_SERVICE_ID,
  PI_CLI,
  TIMELINE_MODEL,
  TIMELINE_PROMPT,
  SELF_SLUG,
  SELF_TIMELINE_PROMPT,
} = require("../lib/config");

const DAY = 86_400_000;
const WEEKLY_AFTER_DAYS = 7; // a week gets its line once it ENDED ≥7 days ago (recent week lives in the prose)
const WEEKLY_UNTIL_DAYS = 70; // months fully older than this fold into a month note
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
// Nathan's own Timeline runs on the self model, passed in by crm-daily. Absent = the self
// pass is off and his Timeline is not built.
const SELF_MODEL_EFF = argVal("--self-model");
// A self week is every conversation at once (median ~86k tokens of raw lines), so its
// summary call gets far longer than a contact week's 2 minutes.
const SELF_CALL_TIMEOUT_MS = 600_000;


// Replaces the original claude.exe call: invoke `pi` headless, prompt via
// stdin, `pi -p` prints just the response text on stdout. Never throws —
// the Timeline step must never crash the pipeline on a model error.
// Set once per run (in main) to a throwaway session dir under data/ so each
// summary's real pi usage is recorded and can be summed for the "actual" cost in
// the ledger; deleted after the run. null → stay ephemeral (--no-session).
let SESSION_CAPTURE = null;

function piSummarize(prompt, system, { model = TIMELINE_MODEL_EFF, timeoutMs = 120_000 } = {}) {
  if (NO_LLM) return "(summary skipped: --no-llm)";
  try {
    const sessionArgs = SESSION_CAPTURE ? ["--session-dir", SESSION_CAPTURE] : ["--no-session"];
    const argv = [PI_CLI, "-p", ...sessionArgs, "-nc", "--no-extensions", "--no-skills", "--no-tools", "--model", model];
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
        timeout: timeoutMs,
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
  weekly: "Summarize the period in 1-2 lines: the main threads and every durable fact, nothing else. Short past-tense sentences separated by periods, not semicolons. At most ~110 words: cut words and noise, never a durable fact.",
  // monthly: distills one calendar month's weekly lines into its Monthly-log note, in a
  // single call (no existing note to rewrite — a month is folded exactly once). Input is
  // weekly SUMMARIES, not raw messages. Replaces the retired season `era` string (and the
  // retired `daily` one — see the header). Text authored by Fable; see ENGINEERING-LOG.
  monthly: "Distill the month into one note: only what will still matter in a year — life events, durable changes (job, school, moves, relationships), big decisions, money milestones. Drop week-by-week narration and logistics. When a later week changes or reverses an earlier fact, keep only the outcome. One paragraph of short past-tense sentences separated by periods, not semicolons. At most ~90 words: cut words and noise, never a durable fact.",
};

// Exported so evals/ can build the exact prompt this pipeline sends without
// re-implementing it — the same reason crm-merge.js takes a promptFile override.
function buildSummaryPrompt(who, periodLabel, lines, style, template) {
  return render(template, {
    // Month calls read weekly summaries, not raw messages — the framing must say so.
    PERIOD_SENTENCE: style === "monthly"
      ? `These are one-line weekly summaries of Signal messages ${who} during ${periodLabel}.`
      : `These are Signal messages ${who} during ${periodLabel}.`,
    STYLE_INSTRUCTION: STYLE_INSTRUCTION[style] || STYLE_INSTRUCTION.weekly,
    // MODEL EGRESS: censor here — the one point the Timeline model reads the lines.
    MESSAGES: forModel(lines.join("\n")),
  });
}

// piSummarize never throws — it returns a placeholder string on error, on an
// empty model reply, or under --no-llm. Those placeholders must never be stored
// as if they were summaries; see the callers in buildConvTiers.
function isBadSummary(s) {
  return !s || /^\((summary (failed|skipped)|no result)/.test(String(s).trim());
}

// Templates are loaded once per file. `ctx` picks the template, model and call timeout —
// the contact/group defaults, or Nathan's own (see buildSelfTimeline). Passed per call,
// never swapped globally, so a self summary can never go out on the contact template.
const TEMPLATES = new Map();
function templateFor(file) {
  if (!TEMPLATES.has(file)) TEMPLATES.set(file, loadTemplate(file));
  return TEMPLATES.get(file);
}
function summarize(who, periodLabel, lines, style, ctx = {}) {
  if (lines.length === 0) return null;
  const { system, user } = buildSummaryPrompt(who, periodLabel, lines, style, templateFor(ctx.templateFile || TIMELINE_PROMPT));
  return piSummarize(user, system, { model: ctx.model || TIMELINE_MODEL_EFF, timeoutMs: ctx.timeoutMs || 120_000 });
}

// ---- timeline block parsing --------------------------------------------------

const TIER_HEADERS = {
  // `raw` is PARSE-ONLY now: renderTimeline no longer emits it, but keeping the
  // header here lets parseTiers still recognize (and thereby DROP) a legacy
  // "### Recent (raw, …)" block left in an old profile, so verbatim message copies
  // clear out on the next run instead of lingering. See the top-of-file note.
  raw: "### Recent (raw, last 7 days)",
  // `daily` is parse-and-drain only: no new day lines are written, but legacy ones stay
  // (and render) until their week gets its weekly line.
  daily: "### Daily log",
  weekly: "### Weekly log",
  monthly: "### Monthly log",
  older: "### Older",
  group: "### Group activity",
};

// Calendar months for the Monthly log. A week belongs to the month of its Monday (the
// same rule the season eras used), so a week is never split across two month notes.
// Keys are "YYYY-MM": they sort chronologically as text and parse with the tier regex.
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function monthKeyOfWeek(weekDateKey) {
  return weekDateKey.slice(0, 7);
}
function monthName(monthKey) {
  const [y, m] = monthKey.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}
// Months ready to fold: every month that has weekly lines, is strictly before
// `cutoffMonth` (so each of its weeks is older than the weekly window), and has no note
// yet. Oldest first. Pure — exported for evals/timeline-tiers-selftest.js.
function foldableMonths(weeklyKeys, monthly, cutoffMonth) {
  return [...new Set(weeklyKeys.map(monthKeyOfWeek))]
    .filter((mk) => mk < cutoffMonth && !monthly.has(mk))
    .sort();
}
// Drop a legacy season era note once month notes cover it: every month of that season
// that has weekly lines must have its month note. A season with NO weekly lines keeps
// its era note — in an old profile that note may be the only record left. Mutates `older`.
function dropSupersededEras(older, weeklyKeys, monthly) {
  for (const k of [...older.keys()]) {
    if (!/^\d{4}-(spring|summer|fall)$/.test(k)) continue;
    const months = new Set(weeklyKeys.filter((w) => eraKey(w) === k).map(monthKeyOfWeek));
    if (months.size && [...months].every((m) => monthly.has(m))) older.delete(k);
  }
}

// Season eras (LEGACY — see dropSupersededEras), Pacific calendar: spring = Jan–May,
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
  const buckets = { raw: [], daily: [], weekly: [], monthly: [], older: [], group: [] };
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
    monthly: toMap(buckets.monthly),
    older: toMap(buckets.older),
    group: buckets.group.filter((l) => l.trim().startsWith("- ")), // flat capped list
    legacyOlder: legacy.join("\n").trim(),
  };
}

function renderTimeline(t, { includeGroup }) {
  const sortDesc = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const out = ["## Timeline"];
  const lines = (m) => sortDesc(m).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  // Legacy day lines render only while any remain (draining into their weekly line).
  if (t.daily.size) out.push("", TIER_HEADERS.daily, lines(t.daily));
  out.push("", TIER_HEADERS.weekly, t.weekly.size ? lines(t.weekly) : "_(none yet)_");
  out.push("", TIER_HEADERS.monthly, t.monthly.size ? lines(t.monthly) : "_(none yet)_");
  // Older is legacy-only now (curated pre-existing text + unsuperseded season eras), so
  // it renders only when it holds something.
  const olderLines = [...t.older.entries()]
    .sort((a, b) => (eraSortKey(a[0]) < eraSortKey(b[0]) ? 1 : -1))
    .map(([k, v]) => `- ${k}: ${v}`);
  const older = [olderLines.join("\n"), t.legacyOlder].filter(Boolean).join("\n\n").trim();
  if (older) out.push("", TIER_HEADERS.older, older);
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
// opts.grouped (the self Timeline): instead of one interleaved list, emit one block per
// conversation — its lines in time order — blocks ordered by their first message and
// separated by an empty line.
function messagesBetween(cdb, convs, fromMs, toMs, opts = {}) {
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
  const fmt = (m) => formatLine({ sentAt: m.sent_at, rid: m.rid, prefix: m._c.prefix || "", sender: m.sender, body: renderedBody(cdb, m) });
  let lines;
  if (opts.grouped) {
    const blocks = new Map(); // convId -> rows; insertion order = first-message order
    for (const m of rows) {
      if (!blocks.has(m._c.convId)) blocks.set(m._c.convId, []);
      blocks.get(m._c.convId).push(m);
    }
    lines = [];
    for (const list of blocks.values()) {
      if (lines.length) lines.push("");
      for (const m of list) lines.push(fmt(m));
    }
  } else {
    lines = rows.map(fmt);
  }
  return {
    // Uncensored RENDERED lines (body + OCR/STT fold). Censoring is applied at model
    // egress in buildSummaryPrompt (the timeline model's only entry point), never here.
    lines,
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

// The Monday-04:00-Pacific week key a daily key ("YYYY-MM-DD") belongs to. Uses a
// mid-day instant (far from any DST edge) so weekStart lands on the correct Monday
// regardless of that date's offset. Lets the daily-deletion rule find a daily's
// week without threading the timestamp through the parsed profile.
function weekKeyOfDay(dayKey) {
  const [y, mo, d] = dayKey.split("-").map(Number);
  return dateKey(weekStart(Date.UTC(y, mo - 1, d, 19, 0)));
}

// The Monday-04:00-Pacific week's start instant for a week key ("YYYY-MM-DD", the
// week's Monday). Mid-day anchor for the same DST reason as weekKeyOfDay.
function weekStartOfKey(weekKey) {
  const [y, mo, d] = weekKey.split("-").map(Number);
  return weekStart(Date.UTC(y, mo - 1, d, 19, 0));
}

// Mutates `t` (daily/weekly/monthly/older maps). Returns { summaries, attempts,
// newWeeklies, historyFrom }.
function buildConvTiers(cdb, convs, who, since, now, t, ctx = {}) {
  let summaries = 0;
  let attempts = 0; // model calls this run WOULD make — the cost preview under --no-llm
  const newWeeklies = new Map();
  // Weekly: one line per whole Monday-04:00-Pacific week (lib/weeks.js's own week
  // boundary — not an ISO-UTC week) that ENDED at least WEEKLY_AFTER_DAYS ago, from the
  // raw messages. nextWeekStart is the only week-stepping primitive lib/weeks.js exports,
  // so walk forward from the oldest candidate week rather than back from now. Keyed by
  // the week's Monday date.
  //
  // ONLY COMPLETE WEEKS, and only once fully aged: summarizing a week still in progress
  // would freeze a clipped range under its key (`t.weekly.has` skips filled keys forever).
  const weeklyEnd = now - WEEKLY_AFTER_DAYS * DAY;
  const monthBoundary = now - WEEKLY_UNTIL_DAYS * DAY;
  // Forward runs walk the last ~10 weeks (so a week whose call failed is retried while it
  // is still recent); a --backfill walks from the first archived message, so every
  // complete historical week gets its line — the same set a pipeline running since day
  // one would have built.
  let historyFrom = null;
  let weeklyFrom = weekStart(monthBoundary);
  if (BACKFILL) {
    const first = firstArchivedMs(cdb, convs);
    if (first != null && weekStart(first) < weeklyFrom) weeklyFrom = weekStart(first);
    historyFrom = first;
  }
  for (let wStart = weeklyFrom; nextWeekStart(wStart) <= weeklyEnd; wStart = nextWeekStart(wStart)) {
    if (wStart < since) continue;
    const key = dateKey(wStart);
    if (t.weekly.has(key)) continue;
    const lines = messagesBetween(cdb, convs, wStart, nextWeekStart(wStart), { grouped: ctx.grouped }).lines;
    if (lines.length === 0) continue;
    attempts++;
    const wsum = summarize(who, `the week of ${key}`, lines, "weekly", ctx);
    // A failed or skipped summary must NOT be stored: the `t.weekly.has(key)` guard
    // above skips any filled key forever, so one transient model error would leave
    // "(summary failed: …)" in the Timeline for good. Leaving the key empty means the
    // next run simply retries the week.
    if (isBadSummary(wsum)) continue;
    t.weekly.set(key, wsum);
    newWeeklies.set(key, wsum);
    summaries++;
  }
  // LEGACY daily lines (from before week→month) drain here: drop a daily ONLY once its
  // week actually has a weekly line — never before, or a week whose weekly failed would
  // lose its content with nowhere to go (a permanent tier hole).
  for (const k of [...t.daily.keys()]) if (t.weekly.has(weekKeyOfDay(k))) t.daily.delete(k);

  // ---- month fold: a calendar month fully older than the weekly window distills its
  // weekly lines into ONE month note, once. Weekly lines are KEPT (Nathan's rule: every
  // week stays viewable). No watermark and no rewrite loop: a month with a note is done,
  // and a failed call just leaves the month unfolded for the next run to retry.
  const cutoffMonth = monthKeyOfWeek(dateKey(weekStart(monthBoundary)));
  const weeklyKeys = [...t.weekly.keys()].sort();
  for (const mk of foldableMonths(weeklyKeys, t.monthly, cutoffMonth)) {
    const lines = weeklyKeys.filter((k) => monthKeyOfWeek(k) === mk).map((k) => `- week of ${k}: ${t.weekly.get(k)}`);
    attempts++;
    const note = summarize(who, monthName(mk), lines, "monthly", ctx);
    if (isBadSummary(note)) continue;
    t.monthly.set(mk, note.trim());
    summaries++;
  }
  dropSupersededEras(t.older, weeklyKeys, t.monthly);

  return { summaries, attempts, newWeeklies, historyFrom };
}

function backupAndWrite(file, next) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(file, `${BACKUP_DIR}/${path.basename(file)}.${Date.now()}.bak`);
  fs.writeFileSync(file, next);
}

// ---- contact + group Timeline builders ----------------------------------------

function buildConversationTimeline({ cdb, convs, who, file, stateKey, state, now, includeGroup, foldLines, ctx }) {
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

  const { summaries, attempts, newWeeklies, historyFrom } =
    buildConvTiers(cdb, convs, who, since, now, t, ctx);
  const sinceOut = BACKFILL
    ? Math.min(historyFrom != null ? historyFrom : now, prevSince != null ? prevSince : now)
    : since;

  // Merge folded group-activity lines (newest first, capped). When the cap drops
  // lines, leave a marker so the truncation is visible (the fuller history lives in
  // each group's own timeline). Strip any prior marker first so it can't accumulate.
  const GROUP_TRUNC = 'older group-activity lines omitted — see the group’s own timeline';
  if (includeGroup) {
    t.group = t.group.filter((l) => !l.includes(GROUP_TRUNC));
    const merged = foldLines && foldLines.length ? [...foldLines, ...t.group] : t.group;
    // DEDUPE by the "- YYYY-MM-DD [Group]:" key, keeping the first occurrence (fresh fold
    // lines come first). This makes fold application IDEMPOTENT: re-applying a pending fold
    // after a crash (see the durable pending-folds queue in main) can't double a line, and a
    // group day already present in the profile is never appended twice.
    const seen = new Set();
    const combined = [];
    for (const l of merged) {
      const k = (l.match(/^- \d{4}-\d{2}-\d{2} \[[^\]]*\]:/) || [null])[0];
      if (k) { if (seen.has(k)) continue; seen.add(k); }
      combined.push(l);
    }
    // Newest first by the line's date key (stable), so the cap always keeps the most
    // recent weeks — a group backfill folds its whole history in oldest-first.
    const dk = (l) => (l.match(/^- (\d{4}-\d{2}-\d{2}) \[/) || [null, ""])[1];
    combined.sort((a, b) => (dk(a) < dk(b) ? 1 : dk(a) > dk(b) ? -1 : 0));
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
  return { changed, summaries, attempts, since: sinceOut, next, newWeeklies };
}

function buildContactTimeline(cdb, sdb, slug, state, now, foldLines, nameMap) {
  const rel = `data/contacts/${slug}.md`;
  const row = cdb.prepare("SELECT signal_id, name FROM contacts WHERE file_path = ?").get(rel);
  if (!row || !row.signal_id) return { slug, skipped: "no crm row" };
  const display = nameMap.get(row.signal_id) || row.name;

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
  // not also fold their weekly summaries into the profile, or everything would
  // appear twice.
  if (groupOthers(conv.members).length <= 1) {
    return { slug: group.slug, name: group.name, participants: [], participantsByWeek: new Map(), ...r };
  }
  // Map each NEW weekly line to the tracked contacts who spoke THAT week, so a week's
  // group summary folds only into the profiles of people who were actually in it.
  const participantsByWeek = new Map();
  const all = new Set();
  for (const wk of (r.newWeeklies || new Map()).keys()) {
    const ws = weekStartOfKey(wk);
    const ps = [];
    for (const sid of messagesBetween(cdb, [convSpec], ws, nextWeekStart(ws)).senders) {
      if (sid === BOT_SERVICE_ID) continue;
      const c = cdb.prepare("SELECT file_path FROM contacts WHERE signal_id = ?").get(sid);
      if (c && c.file_path && c.file_path.startsWith("data/contacts/")) {
        const pslug = c.file_path.replace("data/contacts/", "").replace(/\.md$/, "");
        // Don't fold group activity into the owner's own profile.
        if (pslug !== "nathan" && !ps.includes(pslug)) { ps.push(pslug); all.add(pslug); }
      }
    }
    participantsByWeek.set(wk, ps);
  }
  return { slug: group.slug, name: group.name, participants: [...all], participantsByWeek, ...r };
}

// Nathan's own Timeline (lib/self.js): every archived conversation, all speakers, no
// group-activity fold (every group is already one of its sources), grouped raw input,
// the self template and the self model.
function buildSelfTimeline(cdb, sdb, state, now, nameMap) {
  const SELF = require("../lib/self");
  const convs = SELF.selfConversations(cdb, sdb, nameMap).map((c) => ({
    convId: c.convId, prefix: `(${c.label}) `, conversation: c.label,
  }));
  if (convs.length === 0) return { slug: SELF_SLUG, skipped: "no conversations" };
  // The stub (Relationship _self_, no Email line) must exist before the Timeline writes
  // one of its own — buildConversationTimeline's fallback stub is a contact's.
  if (WRITE) SELF.ensureSelfProfile(cdb, convs.map((c) => c.convId));
  const r = buildConversationTimeline({
    cdb,
    convs,
    who: "from all of Nathan's conversations",
    file: `${CONTACTS_DIR}/${SELF_SLUG}.md`,
    stateKey: SELF_SLUG,
    state,
    now,
    includeGroup: false,
    ctx: { grouped: true, templateFile: SELF_TIMELINE_PROMPT, model: SELF_MODEL_EFF, timeoutMs: SELF_CALL_TIMEOUT_MS },
  });
  return { slug: SELF_SLUG, name: SELF.SELF_NAME, ...r };
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
  const cdb = openCrmDb();
  const sdb = openSignalDb();
  const nameMap = signalNameMap(sdb);
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
  // Nathan's own profile is never a contact here (Phase 3 builds it, on its own model).
  const slugs = (groupArg ? [] : slugArg ? [slugArg] : JSON.parse(fs.readFileSync(TRACKED, "utf8")).slugs)
    .filter((s) => s !== SELF_SLUG);
  const runSelf = Boolean(SELF_MODEL_EFF) && !groupArg && (!slugArg || slugArg === SELF_SLUG);

  console.log(`crm-timeline: ${WRITE ? "WRITE" : "DRY-RUN"}${NO_LLM ? " | --no-llm" : ""}${BACKFILL ? " | BACKFILL (whole history)" : ""} | ${slugs.length} contact(s), ${groups.length} group(s)\n`);

  // Tallies for the /admin/runs ledger: how many conversations were processed
  // (not skipped), how many had their profile changed, and total summary lines.
  let scanned = 0;
  let changedCount = 0;
  let summariesCount = 0;
  let selfSummaries = 0; // priced on the self model, not TIMELINE_MODEL_EFF

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

  // Atomic + INCREMENTAL state persistence. Bare writeFileSync (the old form) could tear
  // TIMELINE_STATE on a crash → loadState reads {} → since=now → every day older than the
  // corruption is skipped forever (a permanent tier hole) and every era re-folds. Writing
  // atomically after EACH group/contact (not only at the end) also means a mid-run crash
  // keeps the state of everything already done.
  const writeState = () => { if (WRITE) writeJsonAtomic(TIMELINE_STATE, state); };

  // Phase 1: groups first, so their new weekly summaries can fold into participant profiles.
  // DURABLE FOLD QUEUE (H4). A crash between a group's day being written (here) and that day
  // being folded into participants (Phase 2) used to lose the fold line forever: the next
  // run's group build saw the week already present and emitted no newWeeklies, so nothing
  // re-folded. So each group's fold lines are mirrored into state._pendingFolds and persisted
  // ATOMICALLY TOGETHER with the group's state advance; Phase 2 clears a contact's entry only
  // once it has absorbed the lines. A crash just replays them next run — idempotently, thanks
  // to the dedupe in buildConversationTimeline.
  const foldByContact = new Map(); // slug -> [ "- YYYY-MM-DD [Group]: summary", ... ]
  // Seed from any folds a previous (crashed) run persisted but never applied.
  for (const [slug, lines] of Object.entries(state._pendingFolds || {})) foldByContact.set(slug, [...lines]);
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
    // One fold line per new weekly group summary, routed to the people who spoke that week.
    const groupFolds = [...(r.newWeeklies || new Map())].map(([week, summary]) => ({
      line: `- ${week} [${r.name}]: ${summary}`,
      to: (r.participantsByWeek && r.participantsByWeek.get(week)) || [],
    }));
    for (const { line, to } of groupFolds) {
      for (const slug of to) {
        if (!foldByContact.has(slug)) foldByContact.set(slug, []);
        foldByContact.get(slug).push(line);
      }
    }
    if (WRITE) {
      state[`group:${g.slug}`] = { since: r.since, ranAt: now };
      // Mirror this group's folds into the durable queue, then persist state + queue together.
      state._pendingFolds = state._pendingFolds || {};
      for (const { line, to } of groupFolds) {
        for (const slug of to) {
          (state._pendingFolds[slug] = state._pendingFolds[slug] || []).push(line);
        }
      }
      writeState();
    }
    if (!WRITE && r.next && groupArg) printTimeline(r.next);
  }

  // Phase 2: contacts (with any folded group activity, including replayed pending folds).
  for (const slug of slugs) {
    const r = buildContactTimeline(cdb, sdb, slug, state, now, foldByContact.get(slug) || [], nameMap);
    if (r.skipped) {
      console.log(`- ${slug}: skipped (${r.skipped})`);
      continue;
    }
    scanned += 1;
    if (r.changed) changedCount += 1;
    summariesCount += r.summaries || 0;
    console.log(`- ${slug} (${r.name}): summaries=${r.summaries}/${r.attempts} changed=${r.changed}`);
    if (WRITE) {
      state[slug] = { since: r.since, ranAt: now };
      // This contact has absorbed its group-activity folds into its own profile — drop them
      // from the durable queue so they aren't replayed.
      if (state._pendingFolds) delete state._pendingFolds[slug];
      writeState();
    }
    if (!WRITE && r.next && slugArg) printTimeline(r.next);
  }

  // Phase 3: Nathan's own Timeline, on the self model.
  if (runSelf) {
    const r = buildSelfTimeline(cdb, sdb, state, now, nameMap);
    if (r.skipped) console.log(`- ${SELF_SLUG}: skipped (${r.skipped})`);
    else {
      scanned += 1;
      if (r.changed) changedCount += 1;
      selfSummaries += r.summaries || 0;
      console.log(`- ${SELF_SLUG} (self, ${SELF_MODEL_EFF}): summaries=${r.summaries}/${r.attempts} changed=${r.changed}`);
      if (WRITE) { state[SELF_SLUG] = { since: r.since, ranAt: now }; writeState(); }
      if (!WRITE && r.next && slugArg) printTimeline(r.next);
    }
  } else if (slugArg === SELF_SLUG) {
    console.log(`- ${SELF_SLUG}: skipped (self profile is off — no --self-model)`);
  }

  sdb.close();
  cdb.close();
  writeState();

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
      const perSelf = selfSummaries ? cost.shortCallUsd(SELF_MODEL_EFF) : 0;
      costUsd = per == null || perSelf == null ? null : per * summariesCount + perSelf * selfSummaries;
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
        summaries: summariesCount + selfSummaries,
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
module.exports = { weekKeyOfDay, weekStartOfKey, monthKeyOfWeek, monthName, foldableMonths, dropSupersededEras, STYLE_INSTRUCTION };

if (require.main === module) {
  // Cross-process pipeline lock (see lib/pipeline-lock.js). The Timeline step
  // rewrites profiles and runs a sweep first, so it must not overlap another run.
  const lock = require('../lib/pipeline-lock').acquire('timeline');
  if (!lock.ok) { console.log(`crm-timeline: skipped, run in progress (${lock.holderDesc}).`); process.exit(0); }
  try { main(); } finally { lock.release(); }
}
