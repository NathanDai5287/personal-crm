'use strict';
// lib/schema.js — the structured half of the CRM.
//
// WHY THIS EXISTS: until now every durable fact about a person lived in markdown
// prose. That was fine for reading and hopeless for everything else. Prose gets
// rewritten wholesale by each merge, so nothing that must SURVIVE a rewrite can
// live there: not provenance, not a period, not a lifecycle. Three things we
// want are all blocked by the same root cause, so they share one substrate here:
//
//   facts     typed attributes with provenance and time semantics
//   mentions  people referencing people, as edges rather than as strings
//
// The markdown profile becomes a RENDER of these tables rather than the store of
// record. That inverts today's relationship, and it's the only way a claim can
// keep its citation across an arbitrary number of future merges.
//
// Everything here is append-mostly: rows are superseded or resolved, never
// UPDATEd in place beyond their lifecycle columns, so the history that led to
// the present state is always reconstructable.

// ---- facts -------------------------------------------------------------------
//
// THE TYPING PROBLEM. "One bucket, last figure survives" is wrong for most real
// attributes, and wrong in different ways:
//
//   STANDING  a fact or rate that holds until restated.
//             "salary is $240k/yr", "works at Tesla", "ownership is 40%".
//             Latest statement wins. Identity is (slug, field).
//
//   PERIODIC  a closed-period measurement. The observation carries the period
//             the SOURCE states: "2024 K-1 distribution: $403,200".
//             The period is part of the fact's IDENTITY, so 2022/2023/2024/2025
//             coexist forever, a corrected 2023 replaces only 2023, and a
//             late-uploaded old K-1 can never stomp the current rate.
//             Identity is (slug, field, period_start, period_end).
//
//   SNAPSHOT  a reading as of an instant. "trust balance $9.6M as of 6/30".
//             Nothing ever replaces anything; successive as-ofs ARE the trend
//             series. Identity is (slug, field, as_of).
//
// The three differ only in what makes a row unique and what supersedes what, so
// one table with a computed `identity_key` expresses all three, and a single
// unique index enforces them. `kind` is not decoration — it selects the rule.
//
// OBSERVED_AT vs RECORDED_AT is the other half of getting this right.
// observed_at is when the fact was SAID (the message's sent_at); recorded_at is
// when we wrote the row. Backfilling 2023 messages in 2026 must not make 2023
// statements look newer than 2025 ones — supersession compares observed_at, so
// running the backfill out of order is safe.

const FACT_KINDS = new Set(['standing', 'periodic', 'snapshot']);
const { dateKey } = require('./weeks');

function factSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id            INTEGER PRIMARY KEY,
      slug          TEXT NOT NULL,        -- whose fact
      field         TEXT NOT NULL,        -- 'employer', 'salary', 'k1_distribution'
      kind          TEXT NOT NULL,        -- standing | periodic | snapshot
      value         TEXT NOT NULL,        -- as rendered for a human
      value_num     REAL,                 -- parsed number when there is one, for trends
      unit          TEXT,                 -- 'USD', 'USD/yr', '%'

      -- periodic only: the period the SOURCE stated, not when we heard it
      period_start  INTEGER,
      period_end    INTEGER,
      period_label  TEXT,                 -- '2024', 'Q3 2025' -- keep the source's words

      -- snapshot only
      as_of         INTEGER,
      as_of_stated  INTEGER DEFAULT 0,    -- 1 = source said it, 0 = inferred from message date

      -- provenance. src_msg is an archive messages.id, the same id cited as m<n>
      src_msg       INTEGER,
      observed_at   INTEGER NOT NULL,     -- when it was SAID
      recorded_at   INTEGER NOT NULL,     -- when we wrote this row
      run_id        TEXT,

      -- lifecycle
      identity_key  TEXT NOT NULL,        -- kind-dependent; see identityKey()
      superseded_by INTEGER,              -- facts.id that replaced this one
      retracted     INTEGER DEFAULT 0,
      retracted_at  INTEGER,              -- manual-clear barrier; blocks older late arrivals

      FOREIGN KEY (superseded_by) REFERENCES facts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_facts_current
      ON facts(slug, field) WHERE superseded_by IS NULL AND retracted = 0;
    CREATE INDEX IF NOT EXISTS idx_facts_identity ON facts(identity_key, observed_at);
    CREATE INDEX IF NOT EXISTS idx_facts_src ON facts(src_msg);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_retry
      ON facts(slug, identity_key, observed_at, IFNULL(src_msg, -1), value);
  `);
  try { db.exec('ALTER TABLE facts ADD COLUMN retracted_at INTEGER'); } catch { /* exists */ }
}

// The kind-dependent identity. Two rows sharing an identity_key are competing
// statements about THE SAME THING; two rows that differ are independent facts
// that must both survive. This one function is where the typing lives.
function identityKey(f) {
  if (f.kind === 'periodic') {
    return `${f.slug}|${f.field}|${f.period_start ?? ''}|${f.period_end ?? ''}`;
  }
  if (f.kind === 'snapshot') {
    // Every reading is its own fact -- a snapshot never competes with anything.
    return `${f.slug}|${f.field}|@${f.as_of ?? ''}`;
  }
  return `${f.slug}|${f.field}`; // standing
}

// ---- derived values: the facts we must REFUSE to store -------------------------
//
// A birthday and an age look like one fact and are two. The birthday is
// invariant; the age is a function of the birthday and today's date. Storing an
// age as a standing fact is a silent time bomb: "29" gets recorded with full
// provenance, supersedes nothing, expires never -- and is simply wrong twelve
// months later while looking exactly as trustworthy as her name. A rotting fact
// is worse than a missing one, because nothing distinguishes it from a good one.
//
// So: STORE THE INVARIANT, DERIVE THE VARIANT. Each of these is computable from
// something we already hold, and the reader computes it at read time.
//
//   age                -> birthday                    (standing)
//   tenure             -> job start date              (standing)
//   years_together     -> anniversary                 (standing)
//   days_since_contact -> max(sent_at) in the archive (not a fact at all)
const DERIVED_FIELDS = new Set(['age', 'tenure', 'years_together', 'days_since_contact']);

// Birthdays arrive as 'YYYY-MM-DD' or -- very often -- as '--MM-DD' with no year
// ("my birthday's March 14"). A yearless birthday cannot yield an age, and
// guessing the year would manufacture a fact nobody stated, so this returns null
// and the reader shows the date alone.
function deriveAge(birthday, at = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthday || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const [ny, nm, nd] = dateKey(at).split('-').map(Number);
  let age = ny - y;
  if (nm < mo || (nm === mo && nd < d)) age -= 1; // birthday not yet reached
  return age >= 0 && age < 130 ? age : null;
}

// Insert a fact and apply the supersession rule for its kind. Returns
// { id, superseded, staleOnArrival }.
//
// The subtle case is STALE ON ARRIVAL: backfilling old messages means a fact
// can arrive whose observed_at is OLDER than the current winner. It must be
// recorded (it is real, and it is part of the history) but must NOT take the
// crown. So it is born with superseded_by already pointing at the incumbent.
// This is what makes "a late-uploaded old K-1 can never stomp the current rate"
// true structurally rather than by convention -- and what makes the backfill
// safe to run in any order.
function recordFact(db, f) {
  if (!FACT_KINDS.has(f.kind)) throw new Error(`bad fact kind: ${f.kind}`);
  // A derived field as STANDING is the bug the section above describes. As a
  // SNAPSHOT it is the honest fallback: when someone states an age but never a
  // birthday we do not hold the invariant, and inventing a birth year would
  // fabricate a claim nobody made. "29 as of Mar 2026" stays true forever and
  // still lets the reader infer ~30 today. So the guard is kind-aware, and this
  // is the clearest argument for `snapshot` existing as its own kind.
  if (DERIVED_FIELDS.has(f.field) && f.kind !== 'snapshot') {
    throw new Error(`'${f.field}' is derived — store the invariant it comes from, or record it as a snapshot`);
  }
  factSchema(db);
  const key = identityKey(f);
  const now = Date.now();

  // A successful model edit can be followed by a frontier-write failure. The next
  // run replays the same chunk, so structured writes must be idempotent.
  const duplicate = db.prepare(`
    SELECT id FROM facts
    WHERE slug = ? AND identity_key = ? AND observed_at = ?
      AND IFNULL(src_msg, -1) = IFNULL(?, -1) AND value = ?
    LIMIT 1`).get(f.slug, key, f.observed_at, f.src_msg ?? null, f.value);
  if (duplicate) return { id: duplicate.id, superseded: false, staleOnArrival: false, duplicate: true };

  // Different snapshot as-ofs have different identity keys and coexist. A corrected
  // reading for the SAME as-of competes normally and supersedes its predecessor.
  const incumbent = db.prepare(`
    SELECT id, observed_at, retracted, retracted_at FROM facts
    WHERE identity_key = ? AND superseded_by IS NULL
    ORDER BY CASE WHEN retracted = 1 THEN COALESCE(retracted_at, observed_at) ELSE observed_at END DESC
    LIMIT 1`).get(key);

  const incumbentAt = incumbent && incumbent.retracted
    ? (incumbent.retracted_at ?? incumbent.observed_at)
    : (incumbent && incumbent.observed_at);
  const stale = Boolean(incumbent && incumbentAt > f.observed_at);

  const info = db.prepare(`
    INSERT INTO facts (slug, field, kind, value, value_num, unit,
      period_start, period_end, period_label, as_of, as_of_stated,
      src_msg, observed_at, recorded_at, run_id, identity_key, superseded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    f.slug, f.field, f.kind, f.value, f.value_num ?? null, f.unit ?? null,
    f.period_start ?? null, f.period_end ?? null, f.period_label ?? null,
    f.as_of ?? null, f.as_of_stated ? 1 : 0,
    f.src_msg, f.observed_at, now, f.run_id ?? null, key,
    stale ? incumbent.id : null,
  );
  const id = info.lastInsertRowid;

  // Fresh fact beats the incumbent: retire the incumbent, pointing at us.
  if (incumbent && !stale) {
    db.prepare('UPDATE facts SET superseded_by = ? WHERE id = ?').run(id, incumbent.id);
  }
  return { id, superseded: Boolean(incumbent && !stale), staleOnArrival: stale };
}

// The present state: one row per live identity. Everything else is history,
// still on disk, reachable by following superseded_by.
function currentFacts(db, slug) {
  return db.prepare(`
    SELECT * FROM facts
    WHERE slug = ? AND superseded_by IS NULL AND retracted = 0
    ORDER BY field, COALESCE(period_start, as_of, observed_at) DESC`).all(slug);
}

// How a single attribute got to where it is -- the audit trail behind one line
// of the profile.
function factHistory(db, slug, field) {
  return db.prepare(
    'SELECT * FROM facts WHERE slug = ? AND field = ? ORDER BY observed_at ASC'
  ).all(slug, field);
}

function retractCurrentFact(db, slug, field, retractedAt = Date.now()) {
  factSchema(db);
  return db.prepare(`UPDATE facts SET retracted = 1, retracted_at = ?
    WHERE slug = ? AND field = ? AND superseded_by IS NULL AND retracted = 0`).run(retractedAt, slug, field).changes;
}

// ---- mentions ----------------------------------------------------------------
//
// Today a person's name inside another person's profile is an opaque string.
// Nothing links "Nathan" to nathan.md, nothing survives a rename, and "who else
// talks about Vlad" is a grep rather than a query. Mentions make that an edge.
//
// The rename argument is not hypothetical: this repo tracked a group as "Third
// Woman" while Signal had long since renamed it "Nat & Kat", and nothing
// noticed. Slugs are stable identifiers; display names are not.

function mentionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mentions (
      id          INTEGER PRIMARY KEY,
      from_slug   TEXT NOT NULL,          -- the speaker (who referenced them)
      to_slug     TEXT NOT NULL,          -- who was referenced
      kind        TEXT NOT NULL,          -- mentioned | coattended | related
      note        TEXT,                   -- 'Katia's roommate'
      src_msg     INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      run_id      TEXT,
      UNIQUE(from_slug, to_slug, kind, src_msg)
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_to ON mentions(to_slug);
    CREATE INDEX IF NOT EXISTS idx_mentions_from ON mentions(from_slug);
  `);
  // PROVENANCE OF THE ROW ITSELF. 'scan' rows are produced by the deterministic
  // name scan (crm-mention-scan.js) and are rebuilt wholesale on every sweep;
  // 'model' rows (the retired merge side-channel) are hand-owned and never
  // touched by a rebuild. The DEFAULT keeps every historical row 'model' so a
  // rebuild's `DELETE WHERE source='scan'` can never delete one.
  try { db.exec("ALTER TABLE mentions ADD COLUMN source TEXT NOT NULL DEFAULT 'model'"); } catch { /* exists */ }
  reassignSchema(db);
}

// A human correction that must OUTLIVE the rebuild. The scan re-derives every
// 'scan' edge from message text each sweep, so a one-off "this citation is
// actually about Q, not P" would be clobbered on the next run. Instead the
// correction is stored here as an override keyed by the immutable message +
// speaker + originally-detected target, and the scanner consults it while
// inserting — so the corrected target survives every idempotent rebuild.
function reassignSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mention_reassign (
      src_msg    INTEGER NOT NULL,        -- the archive message the citation lives on
      from_slug  TEXT NOT NULL,           -- the speaker (unchanged by the correction)
      orig_to    TEXT NOT NULL,           -- who the scan resolved (the wrong target)
      new_to     TEXT NOT NULL,           -- who it should point at instead
      created_at INTEGER NOT NULL,
      PRIMARY KEY (src_msg, from_slug, orig_to)
    );
  `);
}

function recordMention(db, m) {
  mentionSchema(db);
  return Number(db.prepare(`
    INSERT OR IGNORE INTO mentions (from_slug, to_slug, kind, note, src_msg, observed_at, run_id, source)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    m.from_slug, m.to_slug, m.kind || 'mentioned', m.note ?? null,
    m.src_msg, m.observed_at, m.run_id ?? null, m.source || 'model',
  ).changes || 0);
}

// Record (or update) a correction. Upsert on the immutable key so re-linking the
// same citation twice just moves the target.
function recordReassign(db, r) {
  reassignSchema(db);
  return Number(db.prepare(`
    INSERT INTO mention_reassign (src_msg, from_slug, orig_to, new_to, created_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(src_msg, from_slug, orig_to) DO UPDATE SET new_to = excluded.new_to, created_at = excluded.created_at`).run(
    r.src_msg, r.from_slug, r.orig_to, r.new_to, r.created_at ?? Date.now(),
  ).changes || 0);
}

// The whole override table as a lookup the scanner applies as it inserts:
// `${src_msg}|${from_slug}|${orig_to}` -> new_to.
function reassignMap(db) {
  reassignSchema(db);
  const m = new Map();
  for (const r of db.prepare('SELECT src_msg, from_slug, orig_to, new_to FROM mention_reassign').all()) {
    m.set(`${r.src_msg}|${r.from_slug}|${r.orig_to}`, r.new_to);
  }
  return m;
}

// ---- graph queries -----------------------------------------------------------
// Directed edges split by speaker: one row per (from_slug -> to_slug) pair, its
// weight the number of citations and `last` the most recent. This is the whole
// node-link diagram in one query; the page adds display names and geometry.
// The conv_ids that are effectively 1:1 — a DM OR a two-person "bi-group" (e.g. "Nat &
// Kat") — identified by having <=2 human participants (Nathan folded to one, the bot
// excluded). This is what lets hideDm treat a bi-group like a DM; a real multi-group
// (3+ people) is not in the set, so naming someone there still counts.
function oneOnOneConvIds(db) {
  const { MY_SERVICE_ID, BOT_SERVICE_ID } = require('./config');
  const set = new Set();
  try {
    for (const r of db.prepare(
      `SELECT conv_id FROM messages
       WHERE conv_id IS NOT NULL AND (src IS NULL OR src <> ?)
       GROUP BY conv_id
       HAVING COUNT(DISTINCT CASE WHEN type='outgoing' OR src = ? THEN '_me' ELSE src END) <= 2`
    ).all(BOT_SERVICE_ID, MY_SERVICE_ID)) set.add(r.conv_id);
  } catch { /* no messages table yet */ }
  return set;
}

// The hideDm predicate: a citation is trivial when its conversation is effectively 1:1
// (its conv_id is in `oo`) AND the target is one of that chat's two people (Nathan or the
// row's contact_slug). COALESCE guards a LEFT-JOIN miss (NULL conv_id) from three-valued
// filtering. Returns '' when there are no 1:1 conversations (nothing to filter).
function hideDmPredicate(oo) {
  if (!oo.length) return '';
  return `NOT (COALESCE(msg.conv_id,'') IN (${oo.map(() => '?').join(',')}) AND (m.to_slug = 'nathan' OR m.to_slug = msg.contact_slug))`;
}

// opts.hideMine drops edges Nathan speaks (from_slug='nathan'). opts.hideDm drops the
// trivial case of naming the other party of an effectively-1:1 chat (a DM or a bi-group).
// Both filter per-citation, then re-aggregate, so an edge with only trivial citations
// disappears entirely.
function mentionEdges(db, opts = {}) {
  mentionSchema(db);
  // SELF-DEFENDING: only 'scan' rows are graph edges. The scanner writes both ends
  // gated on the tracked set and rebuilds source='scan' wholesale each run; a legacy
  // source='model' row (none exist today, none can be created) could otherwise render
  // an untracked slug as a bare node. Scoping here keeps the graph tracked-only even
  // if such a row ever appears.
  const where = ["m.source = 'scan'"];
  const params = [];
  let join = '';
  if (opts.hideMine) where.push("m.from_slug <> 'nathan'");
  if (opts.hideDm) {
    join = 'LEFT JOIN messages msg ON msg.id = m.src_msg';
    const oo = [...oneOnOneConvIds(db)];
    const pred = hideDmPredicate(oo);
    if (pred) { where.push(pred); params.push(...oo); }
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT m.from_slug, m.to_slug, COUNT(*) n, MAX(m.observed_at) last FROM mentions m ${join} ${w} GROUP BY m.from_slug, m.to_slug ORDER BY n DESC`
  ).all(...params);
}

// Every citation behind one directed edge, newest first, joined to its archive
// message so the panel can show a snippet and link to /m/<src_msg>.
function edgeCitations(db, fromSlug, toSlug, opts = {}) {
  mentionSchema(db);
  const where = ['m.source = ?', 'm.from_slug = ?', 'm.to_slug = ?'];
  const params = ['scan', fromSlug, toSlug];
  if (opts.hideMine) where.push("m.from_slug <> 'nathan'");
  if (opts.hideDm) {
    const oo = [...oneOnOneConvIds(db)];
    const pred = hideDmPredicate(oo);
    if (pred) { where.push(pred); params.push(...oo); }
  }
  return db.prepare(`
    SELECT m.src_msg, m.observed_at, m.note, m.source,
           msg.body, msg.sender, msg.conversation, msg.conv_id, msg.contact_slug
    FROM mentions m
    LEFT JOIN messages msg ON msg.id = m.src_msg
    WHERE ${where.join(' AND ')}
    ORDER BY m.observed_at DESC, m.src_msg DESC`).all(...params);
}

// Everyone who has been referenced in this person's conversations, and everyone
// who has referenced them -- the two directions of the graph.
function neighbors(db, slug) {
  return {
    outbound: db.prepare(
      "SELECT to_slug AS slug, kind, COUNT(*) n, MAX(observed_at) last FROM mentions WHERE source = 'scan' AND from_slug = ? GROUP BY to_slug, kind ORDER BY n DESC"
    ).all(slug),
    inbound: db.prepare(
      "SELECT from_slug AS slug, kind, COUNT(*) n, MAX(observed_at) last FROM mentions WHERE source = 'scan' AND to_slug = ? GROUP BY from_slug, kind ORDER BY n DESC"
    ).all(slug),
  };
}

function ensureSchema(db) {
  factSchema(db);
  mentionSchema(db);
}

module.exports = {
  FACT_KINDS, DERIVED_FIELDS, deriveAge,
  factSchema, identityKey, recordFact, currentFacts, factHistory, retractCurrentFact,
  mentionSchema, recordMention, neighbors,
  reassignSchema, recordReassign, reassignMap, mentionEdges, edgeCitations,
  ensureSchema,
};
