// crm-autopromote.js — auto-add frequently-messaged contacts to the tracked CRM list.
//
// Scans Nathan's Signal 1:1 conversations; any non-tracked person with enough recent
// back-and-forth gets promoted: a stub profile is created, a crm.db row added, and the
// slug appended to crm-tracked.json — so the next refresh/timeline starts tiering them.
//
// SAFE BY DEFAULT — dry-run (just lists candidates) unless --write.
// Usage:
//   node crm-autopromote.js            # dry-run, list who would be promoted
//   node crm-autopromote.js --write    # actually promote

const fs = require("fs");
const { openSignalDb, openCrmDb } = require("../lib/signal-db");
const { TRACKED, CONTACTS_DIR, DISPLAY_NAMES, BOT_SERVICE_ID } = require("../lib/config");
const { dateKey } = require("../lib/weeks");

const DAY = 86_400_000;
const WINDOW_DAYS = 30; // look-back window for "recent activity"
const MIN_MSGS = 25; // promote if >= this many messages exchanged in the window
const MIN_INCOMING = 5; // ...and at least this many were FROM them (not a one-sided blast)

const WRITE = process.argv.includes("--write");

function slugify(name, fallback) {
  const s = (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}
// Pacific calendar date — matches every ledger/Timeline/profile stamp (never UTC,
// or a "Last contact" written after ~4–5pm Pacific would jump to tomorrow).
function todayKey() {
  return dateKey(Date.now());
}

function main() {
  const tracked = JSON.parse(fs.readFileSync(TRACKED, "utf8"));
  const nicks = (() => {
    try {
      return JSON.parse(fs.readFileSync(DISPLAY_NAMES, "utf8")).byServiceId || {};
    } catch {
      return {};
    }
  })();
  const cdb = openCrmDb();
  const sdb = openSignalDb();

  // Already-tracked serviceIds + slugs.
  const trackedSlugs = new Set(tracked.slugs);
  const trackedServiceIds = new Set();
  for (const slug of tracked.slugs) {
    const r = cdb
      .prepare("SELECT signal_id FROM contacts WHERE file_path = ?")
      .get(`data/contacts/${slug}.md`);
    if (r && r.signal_id) trackedServiceIds.add(r.signal_id);
  }
  const contactCols = new Set(cdb.prepare("PRAGMA table_info(contacts)").all().map((c) => c.name));

  const since = Date.now() - WINDOW_DAYS * DAY;
  const convs = sdb
    .prepare(
      `SELECT id, serviceId, COALESCE(name, profileFullName, profileName, e164) AS nm, e164
       FROM conversations WHERE type='private' AND serviceId IS NOT NULL`,
    )
    .all();

  const candidates = [];
  for (const c of convs) {
    if (!c.serviceId || c.serviceId === BOT_SERVICE_ID || trackedServiceIds.has(c.serviceId)) continue;
    const counts = sdb
      .prepare(
        `SELECT
           SUM(CASE WHEN type IN ('incoming','outgoing') THEN 1 ELSE 0 END) AS total,
           SUM(CASE WHEN type='incoming' THEN 1 ELSE 0 END) AS incoming
         FROM messages WHERE conversationId = ? AND body IS NOT NULL AND sent_at >= ?`,
      )
      .get([c.id, since]);
    const total = counts.total || 0;
    const incoming = counts.incoming || 0;
    if (total >= MIN_MSGS && incoming >= MIN_INCOMING) {
      candidates.push({ ...c, total, incoming });
    }
  }
  candidates.sort((a, b) => b.total - a.total);

  console.log(
    `crm-autopromote: ${WRITE ? "WRITE" : "DRY-RUN"} | window=${WINDOW_DAYS}d threshold=${MIN_MSGS}msgs/${MIN_INCOMING}incoming | ${candidates.length} candidate(s)\n`,
  );

  const usedSlugs = new Set(tracked.slugs);
  let promoted = 0;
  const promotedSlugs = [];
  for (const c of candidates) {
    const nick = nicks[c.serviceId];
    const existing = cdb.prepare("SELECT name, file_path FROM contacts WHERE signal_id = ?").get(c.serviceId);
    let slug, name, source;
    if (nick && nick.slug) {
      slug = nick.slug;
      name = nick.name || c.nm || slug;
      source = "display name";
    } else if (existing && existing.file_path) {
      // Already a known contact (under any name) — reuse it, never insert a duplicate.
      slug = existing.file_path.replace("data/contacts/", "").replace(/\.md$/, "");
      name = existing.name || c.nm || slug;
      source = "existing contact";
    } else {
      name = c.nm || c.serviceId.slice(0, 8);
      slug = slugify(name, c.serviceId.slice(0, 8));
      while (usedSlugs.has(slug) || fs.existsSync(`${CONTACTS_DIR}/${slug}.md`)) slug += "-2";
      source = "Signal name — add a display name to crm-display-names.json if wrong";
    }
    usedSlugs.add(slug);
    console.log(`- ${c.nm || c.e164 || c.serviceId} → ${slug} (${name})  (${c.total} msgs, ${c.incoming} from them)  [${source}]`);

    if (!WRITE) continue;

    if (!tracked.slugs.includes(slug)) tracked.slugs.push(slug);
    const rel = `data/contacts/${slug}.md`;
    if (!existing) {
      const vals = { signal_id: c.serviceId, name, phone: c.e164 || null, file_path: rel };
      const cols = Object.keys(vals).filter((k) => contactCols.has(k));
      cdb
        .prepare(`INSERT INTO contacts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .run(...cols.map((k) => vals[k]));
    }
    const absPath = `${CONTACTS_DIR}/${slug}.md`;
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(
        absPath,
        [
          `# ${name}`,
          "",
          `- **Signal ID:** ${c.serviceId}`,
          `- **Phone:** ${c.e164 || "_unknown_"}`,
          "- **Relationship:** _unknown_",
          "- **First contact:** _unknown_",
          `- **Last contact:** ${todayKey()}`,
          "",
          "## What I know",
          "",
          "_(auto-promoted from frequent Signal activity; fills in as the daily refresh runs)_",
          "",
          "## Timeline",
          "",
          "## Open questions",
          "",
        ].join("\n"),
      );
    }
    promoted++;
    promotedSlugs.push(slug);
  }

  sdb.close();
  cdb.close();

  if (WRITE && promoted > 0) {
    fs.writeFileSync(TRACKED, JSON.stringify(tracked, null, 2) + "\n");
    console.log(`\npromoted ${promoted}; added to crm-tracked.json (run crm-timeline next to tier them).`);
  } else if (!WRITE) {
    console.log("\n(dry-run — re-run with --write to promote these.)");
  }
  return { promoted, promotedSlugs };
}

if (require.main === module) {
  main();
} else {
  module.exports = { main };
}
