// crm-compact.js — tiered "resolution gradient" memory for tracked CRM contacts AND groups.
//
// A conversation (a 1:1 DM or a group) keeps its `## Timeline` at decreasing resolution:
//   ### Recent (raw, last 7 days)   verbatim, rebuilt from the Signal DB each run (capped)
//   ### Daily log (7–21 days)        one line per day
//   ### Weekly log (3–10 weeks)      one line per ISO week
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
const { mirrorMessages } = require("../lib/archive");
const { resolveSources, groupOthers } = require("../lib/sources");
const {
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
  MODEL,
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
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const slugArg = argVal("--slug");
const groupArg = argVal("--group");

function pad(n) {
  return String(n).padStart(2, "0");
}
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function isoWeekKey(ms) {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}
function fmtTs(ms) {
  const d = new Date(ms);
  return `${dayKey(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Replaces the original claude.exe call: invoke `pi` headless, prompt via
// stdin, `pi -p` prints just the response text on stdout. Never throws —
// compaction must never crash the pipeline on a model error.
function piSummarize(prompt) {
  if (NO_LLM) return "(summary skipped: --no-llm)";
  try {
    const out = execFileSync(
      process.execPath,
      [PI_CLI, "-p", "--no-session", "-nc", "--no-extensions", "--no-skills", "--no-tools", "--model", MODEL],
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
function summarize(who, periodLabel, lines, style) {
  if (lines.length === 0) return null;
  const prompt = [
    `These are Signal messages ${who} during ${periodLabel}.`,
    style === "daily"
      ? "Summarize the day in ONE concise line: what was discussed/done, plus any durable facts (plans, decisions, life events). Past tense, no preamble."
      : "Summarize the period in 1-2 concise lines: the main threads and any durable facts. Past tense, no preamble.",
    "Each message line starts with a ⟨m…⟩ source id. For each key fact in your summary, cite the id(s) of the message(s) it came from by copying their ⟨m…⟩ marker inline right after the fact (e.g. \"planned camping trip ⟨m88123⟩\"). Cite at most 5 ids total — only the load-bearing messages. Copy ids EXACTLY as they appear; NEVER invent or alter an id.",
    "Output only the summary text, nothing else.",
    "",
    "Messages:",
    lines.join("\n"),
  ].join("\n");
  return piSummarize(prompt);
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

function buildNameMap(sdb, nicks) {
  const m = new Map();
  for (const r of sdb
    .prepare(
      "SELECT serviceId, COALESCE(name, profileFullName, profileName, e164) AS nm FROM conversations WHERE type='private' AND serviceId IS NOT NULL",
    )
    .all())
    if (r.nm) m.set(r.serviceId, r.nm);
  // Override Signal display names with Nathan's nicknames (use his names everywhere).
  for (const [sid, info] of Object.entries(nicks)) if (info && info.name) m.set(sid, info.name);
  return m;
}
// Multi-conversation message fetch. `convs` is a list of sources:
//   { convId, labelFn, prefix, conversation, srcFilter }
//     labelFn(row) -> speaker display label
//     prefix       -> line prefix for group context, e.g. '(Nat & Kat) '
//     conversation -> human label stored in the provenance archive
//     srcFilter    -> optional [serviceIds]: keep only these senders
// Rows from all sources are merged in time order, so a contact's timeline
// interleaves their DM and their group chats exactly like refresh ledgers do.
// `archive` (optional): { cdb, slug } — every row read here is also mirrored
// into crm.db's provenance archive, and each line carries its ⟨m<rowid>⟩ id.
function messagesBetween(sdb, convs, fromMs, toMs, archive) {
  const rows = [];
  for (const c of convs) {
    let sql = `SELECT rowid AS rid, body, sent_at, type, sourceServiceId FROM messages
       WHERE conversationId = ? AND body IS NOT NULL AND type IN ('incoming','outgoing')
         AND sent_at >= ? AND sent_at < ?`;
    const params = [c.convId, fromMs, toMs];
    if (c.srcFilter && c.srcFilter.length) {
      // Outgoing rows often carry a NULL sourceServiceId, so when the filter
      // includes Nathan (bi-groups: both directions) match his messages by
      // type too — mirrors the bi-group clause in crm-refresh.js.
      const srcIn = `sourceServiceId IN (${c.srcFilter.map(() => "?").join(",")})`;
      sql += c.srcFilter.includes(MY_SERVICE_ID) ? ` AND (type = 'outgoing' OR ${srcIn})` : ` AND ${srcIn}`;
      params.push(...c.srcFilter);
    }
    for (const r of sdb.prepare(sql + " ORDER BY sent_at ASC").all(params)) rows.push({ ...r, _c: c });
  }
  rows.sort((a, b) => a.sent_at - b.sent_at || a.rid - b.rid);
  if (archive && rows.length) {
    mirrorMessages(archive.cdb, rows.map((m) => ({
      id: m.rid,
      convId: m._c.convId,
      conversation: m._c.conversation,
      slug: archive.slug || null,
      sentAt: m.sent_at,
      sender: m._c.labelFn(m),
      body: (m.body || "").replace(/\s+/g, " ").trim(),
    })));
  }
  return {
    lines: rows.map((m) => `[${fmtTs(m.sent_at)}] ⟨m${m.rid}⟩ ${m._c.prefix || ""}${m._c.labelFn(m)}: ${(m.body || "").replace(/\s+/g, " ").trim()}`),
    senders: new Set(rows.map((r) => r.sourceServiceId).filter(Boolean)),
  };
}

// ---- shared tiering engine ---------------------------------------------------

// Mutates `t` (daily/weekly/older maps). Returns { rawLines, summaries, newDailies }.
function buildConvTiers(sdb, convs, who, since, now, t, archive) {
  const all = messagesBetween(sdb, convs, now - RAW_DAYS * DAY, now, archive).lines;
  const rawLines = all.slice(-RAW_MAX_MSGS);
  if (all.length > rawLines.length)
    rawLines.unshift(
      `_(${all.length - rawLines.length} earlier messages this week omitted — full log in the Signal DB; fetch with crm-transcript.js)_`,
    );

  let summaries = 0;
  const newDailies = new Map();
  // Daily: ensure a line for each day in [RAW_DAYS, DAILY_UNTIL) that aged out after tiering started.
  for (let d = RAW_DAYS; d < DAILY_UNTIL_DAYS; d++) {
    const dayStart = now - (d + 1) * DAY;
    if (dayStart < since) continue;
    const key = dayKey(dayStart + DAY / 2);
    if (t.daily.has(key) || t.weekly.has(isoWeekKey(dayStart + DAY / 2))) continue;
    const lines = messagesBetween(sdb, convs, dayStart, dayStart + DAY, archive).lines;
    if (lines.length === 0) continue;
    const s = summarize(who, key, lines, "daily");
    t.daily.set(key, s);
    newDailies.set(key, s);
    summaries++;
  }
  // Weekly: roll up weeks older than DAILY_UNTIL (up to WEEKLY_UNTIL), then drop aged dailies.
  for (let wk = Math.floor(DAILY_UNTIL_DAYS / 7); wk * 7 < WEEKLY_UNTIL_DAYS; wk++) {
    const weekStart = now - (wk + 1) * 7 * DAY;
    if (weekStart < since) continue;
    const key = isoWeekKey(now - (wk * 7 + 3) * DAY);
    if (t.weekly.has(key)) continue;
    const lines = messagesBetween(sdb, convs, weekStart, now - wk * 7 * DAY, archive).lines;
    if (lines.length === 0) continue;
    t.weekly.set(key, summarize(who, `the week of ${key}`, lines, "weekly"));
    summaries++;
  }
  const dailyCutoff = dayKey(now - DAILY_UNTIL_DAYS * DAY);
  for (const k of [...t.daily.keys()]) if (k < dailyCutoff) t.daily.delete(k);

  return { rawLines, summaries, newDailies };
}

function backupAndWrite(file, next) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(file, `${BACKUP_DIR}/${path.basename(file)}.${Date.now()}.bak`);
  fs.writeFileSync(file, next);
}

// ---- contact + group compaction ----------------------------------------------

function compactConversation({ sdb, convs, who, file, stateKey, state, now, includeGroup, foldLines, archive }) {
  const ensured = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8")
    : `# ${path.basename(file, ".md")}\n\n## What I know\n\n_(stub)_\n`;
  const { head, timelineExisting, tail } = splitProfile(ensured);
  const t = parseTiers(timelineExisting);
  const since = state[stateKey] && state[stateKey].since != null ? state[stateKey].since : now;

  const { rawLines, summaries, newDailies } = buildConvTiers(sdb, convs, who, since, now, t, archive);

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
  return { changed, summaries, since, rawCount: rawLines.length, next, newDailies };
}

function compactContact(cdb, sdb, slug, state, now, foldLines, nicks) {
  const rel = `data/contacts/${slug}.md`;
  const row = cdb.prepare("SELECT signal_id, name FROM contacts WHERE file_path = ?").get(rel);
  if (!row || !row.signal_id) return { slug, skipped: "no crm row" };
  const display = (nicks[row.signal_id] && nicks[row.signal_id].name) || row.name;
  const first = display.split(" ")[0];

  // Same source universe as crm-refresh.js: DM (all messages), bi-groups
  // (both directions — effectively private channels), multi-groups (only the
  // contact's own messages). Timeline tiers interleave all of them by time.
  const sources = resolveSources(sdb, row.signal_id);
  const dmLabelFn = (m) => (m.type === "outgoing" ? "Nathan" : first);
  const srcLabelFn = (m) => (m.sourceServiceId === MY_SERVICE_ID || m.type === "outgoing" ? "Nathan" : first);
  const convs = [
    ...sources.dmConvIds.map((id) => ({
      convId: id, labelFn: dmLabelFn, prefix: "", conversation: `DM with ${display}`,
    })),
    ...sources.biGroupConvIds.map((id) => ({
      convId: id, labelFn: srcLabelFn, prefix: `(${sources.labels[id]}) `, conversation: sources.labels[id],
      srcFilter: [MY_SERVICE_ID, row.signal_id],
    })),
    ...sources.multiGroupConvIds.map((id) => ({
      convId: id, labelFn: srcLabelFn, prefix: `(${sources.labels[id]}) `, conversation: sources.labels[id],
      srcFilter: [row.signal_id],
    })),
  ];
  if (convs.length === 0) return { slug, skipped: "no conversations" };

  const r = compactConversation({
    sdb,
    convs,
    who: `between Nathan and ${display}`,
    file: `${CONTACTS_DIR}/${slug}.md`,
    stateKey: slug,
    state,
    now,
    includeGroup: true,
    foldLines,
    archive: { cdb, slug },
  });
  return { slug, name: display, ...r };
}

function compactGroup(cdb, sdb, nameMap, group, state, now) {
  const conv = sdb.prepare("SELECT id, members FROM conversations WHERE groupId = ? LIMIT 1").get([group.groupId]);
  if (!conv) return { slug: group.slug, skipped: "no group conversation" };
  const labelFn = (m) =>
    m.type === "outgoing"
      ? "Nathan"
      : m.sourceServiceId === BOT_SERVICE_ID
        ? "Janet"
        : nameMap.get(m.sourceServiceId) || "Someone";
  const convSpec = { convId: conv.id, labelFn, prefix: "", conversation: group.name };
  const r = compactConversation({
    sdb,
    convs: [convSpec],
    who: `in the group "${group.name}"`,
    file: `${GROUPS_DIR}/${group.slug}.md`,
    stateKey: `group:${group.slug}`,
    state,
    now,
    includeGroup: false,
    archive: { cdb, slug: null },
  });
  // Bi-groups (only other party besides me/bot is one person) are already
  // covered IN that person's own timeline via compactContact's sources — do
  // not also fold their day-summaries into the profile, or everything would
  // appear twice.
  if (groupOthers(conv.members).length <= 1) {
    return { slug: group.slug, name: group.name, participants: [], ...r };
  }
  // Map participants (tracked contacts who spoke recently) for folding.
  const recent = messagesBetween(sdb, [convSpec], now - DAILY_UNTIL_DAYS * DAY, now, { cdb, slug: null }).senders;
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
  const nameMap = buildNameMap(sdb, nicks);

  const allGroups = (() => {
    try {
      return JSON.parse(fs.readFileSync(TRACKED_GROUPS, "utf8")).groups || [];
    } catch {
      return [];
    }
  })();
  const groups = groupArg ? allGroups.filter((g) => g.slug === groupArg) : slugArg ? [] : allGroups;
  const slugs = groupArg ? [] : slugArg ? [slugArg] : JSON.parse(fs.readFileSync(TRACKED, "utf8")).slugs;

  console.log(`crm-compact: ${WRITE ? "WRITE" : "DRY-RUN"}${NO_LLM ? " | --no-llm" : ""} | ${slugs.length} contact(s), ${groups.length} group(s)\n`);

  // Phase 1: groups first, so their new day-summaries can fold into participant profiles.
  const foldByContact = new Map(); // slug -> [ "- YYYY-MM-DD [Group]: summary", ... ]
  for (const g of groups) {
    const r = compactGroup(cdb, sdb, nameMap, g, state, now);
    if (r.skipped) {
      console.log(`- group ${g.slug}: skipped (${r.skipped})`);
      continue;
    }
    console.log(`- group ${g.slug} (${r.name}): raw=${r.rawCount} summaries=${r.summaries} participants=[${r.participants.join(", ")}] changed=${r.changed}`);
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
    console.log(`- ${slug} (${r.name}): raw=${r.rawCount} summaries=${r.summaries} changed=${r.changed}`);
    if (WRITE) state[slug] = { since: r.since, ranAt: now };
    if (!WRITE && r.next && slugArg) printTimeline(r.next);
  }

  sdb.close();
  cdb.close();
  if (WRITE) fs.writeFileSync(COMPACT_STATE, JSON.stringify(state, null, 2));
}

function printTimeline(next) {
  const m = next.match(/## Timeline[\s\S]*?(?=\n## |$)/);
  console.log("\n----- proposed Timeline (dry-run) -----\n");
  console.log(m ? m[0] : next);
  console.log("\n----- end -----");
}

main();
