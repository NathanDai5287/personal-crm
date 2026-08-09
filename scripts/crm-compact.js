// crm-compact.js — tiered "resolution gradient" memory for tracked CRM contacts AND groups.
//
// A conversation (a 1:1 DM or a group) keeps its `## Timeline` at decreasing resolution:
//   ### Recent (raw, last 7 days)   verbatim, rebuilt from the Signal DB each run (capped)
//   ### Daily log (7–21 days)        one line per day
//   ### Weekly log (3–10 weeks)      one line per Pacific calendar week (Mon 04:00)
//   ### Older                        coarse/era notes (+ any pre-existing curated timeline)
// Contact profiles also get:
//   ### Group activity               folded day-summaries from groups they're in (capped)
//
// Groups are multi-speaker (raw lines labeled by sender) sourced by groupId. When a group's
// day rolls up into a daily summary, that summary is also folded into each tracked
// participant's profile, so a person's profile reflects their group activity too.
//
// The Signal DB stores every message permanently, so compaction is always recoverable.
//
// SAFE BY DEFAULT — dry-run unless --write. Backs up each file before writing. First run
// only sets up structure (no re-summarizing history); the gradient builds forward from now.
//
// Usage:
//   node crm-compact.js                       # dry-run, all tracked contacts + groups
//   node crm-compact.js --slug katia-jacoby   # dry-run, one contact
//   node crm-compact.js --group third-woman   # dry-run, one group
//   node crm-compact.js --write               # apply (backs up first)
//   node crm-compact.js --no-llm              # structural dry-run, skip summaries

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { openSignalDb, openCrmDb } = require("../lib/signal-db");
const { render, loadTemplate } = require("../lib/compact-prompt");
const { runSweep } = require("./crm-archive");
const { resolveSources, groupOthers } = require("../lib/sources");
const { redact } = require("../lib/redact");
// Pacific, always — see lib/weeks.js header. dateKey/fmtLocal replace this file's old
// getUTC*()-based dayKey/fmtTs (a message at 23:30 Pacific landed on the next UTC day),
// and weekStart/nextWeekStart replace isoWeekKey's UTC-ISO week with the pipeline's own
// Monday-04:00-Pacific week boundary, so the Timeline's tiers bucket the same way every
// other ledger in the system does.
const { dateKey, fmtLocal, weekStart, nextWeekStart } = require("../lib/weeks");
const {
  DATA_DIR,
  TRACKED,
  TRACKED_GROUPS,
  CONTACTS_DIR,
  GROUPS_DIR,
  BACKUP_DIR,
  COMPACT_STATE,
  NICKNAMES,
  MY_SERVICE_ID,
  BOT_SERVICE_ID,
  PI_CLI,
  COMPACT_MODEL,
  COMPACT_PROMPT,
} = require("../lib/config");

const DAY = 86_400_000;
const RAW_DAYS = 7;
const DAILY_UNTIL_DAYS = 21;
const WEEKLY_UNTIL_DAYS = 70;
const RAW_MAX_MSGS = 150; // cap on verbatim lines kept in-profile (full history is in the DB)
const GROUP_ACTIVITY_MAX = 40; // cap on folded group-activity lines per contact

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const NO_LLM = args.includes("--no-llm");
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


// Replaces the original claude.exe call: invoke `pi` headless, prompt via
// stdin, `pi -p` prints just the response text on stdout. Never throws —
// compaction must never crash the pipeline on a model error.
// Set once per run (in main) to a throwaway session dir under data/ so each
// summary's real pi usage is recorded and can be summed for the "actual" cost in
// the ledger; deleted after the run. null → stay ephemeral (--no-session).
let SESSION_CAPTURE = null;

function piSummarize(prompt, system) {
  if (NO_LLM) return "(summary skipped: --no-llm)";
  try {
    const sessionArgs = SESSION_CAPTURE ? ["--session-dir", SESSION_CAPTURE] : ["--no-session"];
    const argv = [PI_CLI, "-p", ...sessionArgs, "-nc", "--no-extensions", "--no-skills", "--no-tools", "--model", COMPACT_MODEL];
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
};

// Exported so evals/ can build the exact prompt this pipeline sends without
// re-implementing it — the same reason crm-merge.js takes a promptFile override.
function buildSummaryPrompt(who, periodLabel, lines, style, template) {
  return render(template, {
    PERIOD_SENTENCE: `These are Signal messages ${who} during ${periodLabel}.`,
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

let COMPACT_TEMPLATE = null;
function summarize(who, periodLabel, lines, style) {
  if (lines.length === 0) return null;
  if (COMPACT_TEMPLATE === null) COMPACT_TEMPLATE = loadTemplate(COMPACT_PROMPT);
  const { system, user } = buildSummaryPrompt(who, periodLabel, lines, style, COMPACT_TEMPLATE);
  return piSummarize(user, system);
}

// ---- timeline block parsing --------------------------------------------------

const TIER_HEADERS = {
  raw: "### Recent (raw, last 7 days)",
  daily: "### Daily log",
  weekly: "### Weekly log",
  older: "### Older",
  group: "### Group activity",
};

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

function renderTimeline(rawLines, t, { includeGroup }) {
  const sortDesc = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const out = ["## Timeline", "", TIER_HEADERS.raw];
  out.push(rawLines.length ? rawLines.join("\n") : "_(no messages in the last 7 days)_");
  for (const [tier, label] of [
    ["daily", "daily"],
    ["weekly", "weekly"],
  ]) {
    out.push("", TIER_HEADERS[tier]);
    out.push(t[tier].size ? sortDesc(t[tier]).map(([k, v]) => `- ${k}: ${v}`).join("\n") : "_(none yet)_");
    void label;
  }
  out.push("", TIER_HEADERS.older);
  const olderLines = sortDesc(t.older).map(([k, v]) => `- ${k}: ${v}`);
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
    let sql = `SELECT id AS rid, body, sent_at, type, src AS sourceServiceId, sender FROM messages
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
    lines: rows.map((m) => `[${fmtLocal(m.sent_at)}] ⟨m${m.rid}⟩ ${m._c.prefix || ""}${m.sender}: ${redact((m.body || "").replace(/\s+/g, " ").trim())}`),
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

// Mutates `t` (daily/weekly/older maps). Returns { rawLines, summaries, newDailies, historyFrom }.
function buildConvTiers(cdb, convs, who, since, now, t) {
  const all = messagesBetween(cdb, convs, now - RAW_DAYS * DAY, now).lines;
  const rawLines = all.slice(-RAW_MAX_MSGS);
  if (all.length > rawLines.length)
    rawLines.unshift(
      `_(${all.length - rawLines.length} earlier messages this week omitted — full log in the archive; fetch with crm-transcript.js)_`,
    );

  let summaries = 0;
  let attempts = 0; // model calls this run WOULD make — the cost preview under --no-llm
  const newDailies = new Map();
  // Daily: ensure a line for each day in [RAW_DAYS, DAILY_UNTIL) that aged out after tiering started.
  for (let d = RAW_DAYS; d < DAILY_UNTIL_DAYS; d++) {
    const dayStart = now - (d + 1) * DAY;
    if (dayStart < since) continue;
    const key = dateKey(dayStart + DAY / 2);
    if (t.daily.has(key) || t.weekly.has(dateKey(weekStart(dayStart + DAY / 2)))) continue;
    const lines = messagesBetween(cdb, convs, dayStart, dayStart + DAY).lines;
    if (lines.length === 0) continue;
    attempts++;
    const s = summarize(who, key, lines, "daily");
    // A failed or skipped summary must NOT be stored. Storing it is permanent:
    // the `t.daily.has(key)` guard above skips any filled key forever, so one
    // transient model error would leave "(summary failed: …)" in the Timeline
    // for good — and compaction is the step whose raw lines get dropped, so
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
  // Dailies survive until their WHOLE week has rolled up: the cutoff is the start
  // of the week containing dailyBoundary (the first week the weekly tier does not
  // own yet), not the raw 21-day line — so the daily tier can briefly hold up to
  // ~27 days, and nothing falls between the tiers.
  const dailyCutoff = dateKey(weekStart(dailyBoundary));
  for (const k of [...t.daily.keys()]) if (k < dailyCutoff) t.daily.delete(k);

  return { rawLines, summaries, attempts, newDailies, historyFrom };
}

function backupAndWrite(file, next) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(file, `${BACKUP_DIR}/${path.basename(file)}.${Date.now()}.bak`);
  fs.writeFileSync(file, next);
}

// ---- contact + group compaction ----------------------------------------------

function compactConversation({ cdb, convs, who, file, stateKey, state, now, includeGroup, foldLines }) {
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

  const { rawLines, summaries, attempts, newDailies, historyFrom } = buildConvTiers(cdb, convs, who, since, now, t);
  const sinceOut = BACKFILL
    ? Math.min(historyFrom != null ? historyFrom : now, prevSince != null ? prevSince : now)
    : since;

  // Merge folded group-activity lines (newest first, capped).
  if (includeGroup && foldLines && foldLines.length) {
    t.group = [...foldLines, ...t.group].slice(0, GROUP_ACTIVITY_MAX);
  }

  const newTimeline = renderTimeline(rawLines, t, { includeGroup });
  const next = `${head}${newTimeline}${tail}`.replace(/\s*$/, "") + "\n";
  const changed = !fs.existsSync(file) || next !== ensured;
  if (changed && WRITE) {
    if (fs.existsSync(file)) backupAndWrite(file, next);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next);
    }
  }
  return { changed, summaries, attempts, since: sinceOut, rawCount: rawLines.length, next, newDailies };
}

function compactContact(cdb, sdb, slug, state, now, foldLines, nicks) {
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
      srcFilter: [MY_SERVICE_ID, row.signal_id],
    })),
    ...sources.multiGroupConvIds.map((id) => ({
      convId: id, prefix: `(${sources.labels[id]}) `, conversation: sources.labels[id],
      srcFilter: [row.signal_id],
    })),
  ];
  if (convs.length === 0) return { slug, skipped: "no conversations" };

  const r = compactConversation({
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

function compactGroup(cdb, sdb, group, state, now) {
  const conv = sdb.prepare("SELECT id, members FROM conversations WHERE groupId = ? LIMIT 1").get([group.groupId]);
  if (!conv) return { slug: group.slug, skipped: "no group conversation" };
  // Speaker labels (incl. 'Janet' for the old bot) come from the archive's
  // sender column, attributed by the sweep with the full group name map.
  const convSpec = { convId: conv.id, prefix: "", conversation: group.name };
  const r = compactConversation({
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
  // covered IN that person's own timeline via compactContact's sources — do
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

// ---- main --------------------------------------------------------------------

function main() {
  const now = Date.now();
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(COMPACT_STATE, "utf8"));
  } catch {}
  const nicks = (() => {
    try {
      return JSON.parse(fs.readFileSync(NICKNAMES, "utf8")).byServiceId || {};
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
  const groups = groupArg ? allGroups.filter((g) => g.slug === groupArg) : slugArg ? [] : allGroups;
  const slugs = groupArg ? [] : slugArg ? [slugArg] : JSON.parse(fs.readFileSync(TRACKED, "utf8")).slugs;

  console.log(`crm-compact: ${WRITE ? "WRITE" : "DRY-RUN"}${NO_LLM ? " | --no-llm" : ""}${BACKFILL ? " | BACKFILL (whole history)" : ""} | ${slugs.length} contact(s), ${groups.length} group(s)\n`);

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
    const r = compactGroup(cdb, sdb, g, state, now);
    if (r.skipped) {
      console.log(`- group ${g.slug}: skipped (${r.skipped})`);
      continue;
    }
    scanned += 1;
    if (r.changed) changedCount += 1;
    summariesCount += r.summaries || 0;
    console.log(`- group ${g.slug} (${r.name}): raw=${r.rawCount} summaries=${r.summaries}/${r.attempts} participants=[${r.participants.join(", ")}] changed=${r.changed}`);
    if (WRITE) state[`group:${g.slug}`] = { since: r.since, ranAt: now };
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
    const r = compactContact(cdb, sdb, slug, state, now, foldByContact.get(slug) || [], nicks);
    if (r.skipped) {
      console.log(`- ${slug}: skipped (${r.skipped})`);
      continue;
    }
    scanned += 1;
    if (r.changed) changedCount += 1;
    summariesCount += r.summaries || 0;
    console.log(`- ${slug} (${r.name}): raw=${r.rawCount} summaries=${r.summaries}/${r.attempts} changed=${r.changed}`);
    if (WRITE) state[slug] = { since: r.since, ranAt: now };
    if (!WRITE && r.next && slugArg) printTimeline(r.next);
  }

  sdb.close();
  cdb.close();
  if (WRITE) fs.writeFileSync(COMPACT_STATE, JSON.stringify(state, null, 2));

  // Record real (write) passes in the /admin/runs ledger. Dry-runs are
  // inspections, not passes, so they leave no row — matching crm-daily, which
  // also skips the ledger on --dry-run. Non-fatal: a failed record must never
  // fail the compaction it describes.
  if (WRITE) {
    const endedAt = Date.now();
    // Estimated Timeline spend: one model call per summary line written. Estimate
    // only (see lib/cost.js) — null if COMPACT_MODEL isn't in pi's price catalog.
    let costUsd = null;
    let actualCostUsd = null;
    try {
      const cost = require("../lib/cost");
      const per = cost.compactCallUsd(COMPACT_MODEL);
      costUsd = per == null ? null : per * summariesCount;
      // Real billed cost, summed from the session dir every summary wrote into.
      if (SESSION_CAPTURE) {
        const a = cost.sumSessionCostUsd(SESSION_CAPTURE);
        if (a) actualCostUsd = a.costUsd;
      }
    } catch { /* pricing is best-effort */ }
    try {
      require("../lib/run-record").writeRunRecord({
        kind: "compact",
        startedAt: now,
        endedAt,
        durationMs: endedAt - now,
        only: slugArg || (groupArg ? `group:${groupArg}` : null),
        scanned,
        changed: changedCount,
        summaries: summariesCount,
        costUsd,
        actualCostUsd,
        costModel: COMPACT_MODEL,
      });
    } catch (e) {
      console.log(`crm-compact: run-record not written (non-fatal): ${e.message}`);
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

if (require.main === module) {
  // Cross-process pipeline lock (see lib/pipeline-lock.js). Compaction rewrites
  // profiles and runs a sweep first, so it must not overlap another run.
  const lock = require('../lib/pipeline-lock').acquire('compact');
  if (!lock.ok) { console.log(`crm-compact: skipped, run in progress (${lock.holderDesc}).`); process.exit(0); }
  try { main(); } finally { lock.release(); }
}
