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
//   todos     commitments with deadlines and a lifecycle
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
      src_msg       INTEGER NOT NULL,
      observed_at   INTEGER NOT NULL,     -- when it was SAID
      recorded_at   INTEGER NOT NULL,     -- when we wrote this row
      run_id        TEXT,

      -- lifecycle
      identity_key  TEXT NOT NULL,        -- kind-dependent; see identityKey()
      superseded_by INTEGER,              -- facts.id that replaced this one
      retracted     INTEGER DEFAULT 0,

      FOREIGN KEY (superseded_by) REFERENCES facts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_facts_current
      ON facts(slug, field) WHERE superseded_by IS NULL AND retracted = 0;
    CREATE INDEX IF NOT EXISTS idx_facts_identity ON facts(identity_key, observed_at);
    CREATE INDEX IF NOT EXISTS idx_facts_src ON facts(src_msg);
  `);
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
  const now = new Date(at);
  const mm = now.getUTCMonth() + 1;
  let age = now.getUTCFullYear() - y;
  if (mm < mo || (mm === mo && now.getUTCDate() < d)) age -= 1; // birthday not yet reached
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

  // Snapshots never compete: every reading stands on its own as a series point.
  const incumbent = f.kind === 'snapshot' ? null : db.prepare(`
    SELECT id, observed_at FROM facts
    WHERE identity_key = ? AND superseded_by IS NULL AND retracted = 0
    ORDER BY observed_at DESC LIMIT 1`).get(key);

  const stale = Boolean(incumbent && incumbent.observed_at > f.observed_at);

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
  factSchema(db);
  return db.prepare(`
    SELECT * FROM facts
    WHERE slug = ? AND superseded_by IS NULL AND retracted = 0
    ORDER BY field, COALESCE(period_start, as_of, observed_at) DESC`).all(slug);
}

// How a single attribute got to where it is -- the audit trail behind one line
// of the profile.
function factHistory(db, slug, field) {
  factSchema(db);
  return db.prepare(
    'SELECT * FROM facts WHERE slug = ? AND field = ? ORDER BY observed_at ASC'
  ).all(slug, field);
}

// ---- todos -------------------------------------------------------------------
//
// Extraction is the easy half; CLOSURE is the hard half. "i'll send you the doc"
// on Monday and "sent it" on Thursday are two messages with no lexical overlap,
// so nothing detects the second resolves the first unless the merge is SHOWN the
// open todos for that contact and asked to resolve them. openTodos() exists for
// exactly that -- it is the input to the prompt, not just a dashboard query.
//
// due_precision is not fussiness. Most real deadlines are fuzzy ("before the
// trip", "end of month"), and storing an invented exact timestamp is worse than
// storing the vagueness honestly: it produces confidently wrong reminders. When
// precision is 'fuzzy' the due_text is the truth and due_at is only a hint.

function todoSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id            INTEGER PRIMARY KEY,
      slug          TEXT NOT NULL,
      text          TEXT NOT NULL,
      owner         TEXT NOT NULL,        -- me | them | both
      due_at        INTEGER,              -- best-effort instant; see due_precision
      due_precision TEXT,                 -- exact | day | week | month | fuzzy | none
      due_text      TEXT,                 -- the source's own words: 'before the trip'
      status        TEXT NOT NULL,        -- open | done | dropped | expired

      src_msg       INTEGER NOT NULL,     -- where the commitment was made
      opened_at     INTEGER NOT NULL,     -- observed_at of src_msg
      resolved_msg  INTEGER,              -- where it was discharged
      resolved_at   INTEGER,
      run_id        TEXT,
      recorded_at   INTEGER NOT NULL,

      dedup_key     TEXT NOT NULL         -- normalized text, so re-merges don't duplicate
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_dedup ON todos(slug, dedup_key);
    CREATE INDEX IF NOT EXISTS idx_todos_open ON todos(slug, status) WHERE status = 'open';
  `);
}

function normalizeTodo(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Idempotent: re-merging the same chunk re-proposes the same commitment, and
// the unique dedup_key turns the second write into a no-op rather than a
// duplicate. Returns { id, created }.
function recordTodo(db, t) {
  todoSchema(db);
  const key = normalizeTodo(t.text);
  const existing = db.prepare('SELECT id FROM todos WHERE slug = ? AND dedup_key = ?').get(t.slug, key);
  if (existing) return { id: existing.id, created: false };
  const info = db.prepare(`
    INSERT INTO todos (slug, text, owner, due_at, due_precision, due_text, status,
      src_msg, opened_at, run_id, recorded_at, dedup_key)
    VALUES (?,?,?,?,?,?,'open',?,?,?,?,?)`).run(
    t.slug, t.text, t.owner || 'both', t.due_at ?? null,
    t.due_precision || 'none', t.due_text ?? null,
    t.src_msg, t.opened_at, t.run_id ?? null, Date.now(), key,
  );
  return { id: info.lastInsertRowid, created: true };
}

function resolveTodo(db, id, status, resolvedMsg, resolvedAt) {
  todoSchema(db);
  db.prepare('UPDATE todos SET status = ?, resolved_msg = ?, resolved_at = ? WHERE id = ?')
    .run(status, resolvedMsg ?? null, resolvedAt ?? Date.now(), id);
}

function openTodos(db, slug) {
  todoSchema(db);
  return db.prepare(
    "SELECT * FROM todos WHERE slug = ? AND status = 'open' ORDER BY COALESCE(due_at, 9e15) ASC"
  ).all(slug);
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
      from_slug   TEXT NOT NULL,          -- in whose conversation it happened
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
}

function recordMention(db, m) {
  mentionSchema(db);
  db.prepare(`
    INSERT OR IGNORE INTO mentions (from_slug, to_slug, kind, note, src_msg, observed_at, run_id)
    VALUES (?,?,?,?,?,?,?)`).run(
    m.from_slug, m.to_slug, m.kind || 'mentioned', m.note ?? null,
    m.src_msg, m.observed_at, m.run_id ?? null,
  );
}

// Everyone who has been referenced in this person's conversations, and everyone
// who has referenced them -- the two directions of the graph.
function neighbors(db, slug) {
  mentionSchema(db);
  return {
    outbound: db.prepare(
      'SELECT to_slug AS slug, kind, COUNT(*) n, MAX(observed_at) last FROM mentions WHERE from_slug = ? GROUP BY to_slug, kind ORDER BY n DESC'
    ).all(slug),
    inbound: db.prepare(
      'SELECT from_slug AS slug, kind, COUNT(*) n, MAX(observed_at) last FROM mentions WHERE to_slug = ? GROUP BY from_slug, kind ORDER BY n DESC'
    ).all(slug),
  };
}

function ensureSchema(db) {
  factSchema(db);
  todoSchema(db);
  mentionSchema(db);
}

module.exports = {
  FACT_KINDS, DERIVED_FIELDS, deriveAge,
  factSchema, identityKey, recordFact, currentFacts, factHistory,
  todoSchema, recordTodo, resolveTodo, openTodos, normalizeTodo,
  mentionSchema, recordMention, neighbors,
  ensureSchema,
};
