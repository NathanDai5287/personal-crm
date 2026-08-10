'use strict';
// lib/tasks.js — commitments Nathan agreed to do.
//
// NOT talking points. The todo list was previously derived from each profile's
// `## Talking points`, and that was wrong: talking points are conversation topics
// ("ask how the desk is holding up", "Patricia moved out") — vague, unassigned, and
// often not actions at all. A todo list full of that is worse than an empty one.
//
// A task here is a COMMITMENT NATHAN MADE: he agreed, in his own words, to do a
// specific thing, alone or jointly. A promise the contact made to him is never a task
// however explicit — see OWNERS below.
// Extracted by scripts/crm-tasks.js, which scans the ledger for Nathan saying "i'll make
// sure to …" (lib/task-trigger.js) and sends only those lines plus context to the model
// via prompts/tasks-trigger.md. A regex decides WHETHER; the model decides WHAT.
//
// WHY THE TABLE AND NOT THE PROFILE MARKDOWN: a task has state — accepted, done,
// deadline, an edited title. Prose in a profile is rewritten by every merge, so
// anything stored there loses its state. Tasks are rows; the profile is not
// involved.
//
// LIFECYCLE
//   draft      extracted by an ingest run, awaiting Nathan's decision
//   active     accepted; title/description/deadline are now his to edit
//   done       completed
//   dismissed  rejected; must never be re-drafted
//
// THE DEDUPE KEY is slug + the source message id + a hash of the title. The id is
// immutable (it names an archived message), so re-extracting the same ledger cannot
// resurrect a dismissed task; the title is in there because one trigger can legitimately
// yield several tasks. See taskKey.

const crypto = require('crypto');

// Nathan only. This was ['nathan','them','mutual']; he ruled that a commitment the
// contact made is never an entry on his list, and a joint undertaking is his because
// he is still on the hook for it. Kept as a set rather than dropped so that anything
// arriving with another owner is caught here instead of being coerced silently — and
// scripts/crm-tasks.js rejects it upstream of this, before it can reach a row.
const OWNERS = new Set(['nathan']);
const STATUSES = new Set(['draft', 'active', 'done', 'dismissed']);

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  slug TEXT NOT NULL,
  contact_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  owner TEXT NOT NULL DEFAULT 'nathan',    -- always 'nathan'; see OWNERS above
  title TEXT NOT NULL,
  description TEXT,
  deadline TEXT,
  confidence TEXT,                         -- retired; measured no signal, kept for old rows
  importance INTEGER NOT NULL DEFAULT 2,   -- derived: 1 + has_deadline + actionable
  source_msg_id INTEGER,                   -- the message where it was agreed
  range_start INTEGER,                     -- semantic citation range: the stretch a reader
  range_end INTEGER,                       --   needs to understand the task (contains the trigger)
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  done_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_slug ON tasks(slug);
`;

// CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so a new column has to be
// added explicitly or every deployment that already has a `tasks` table silently keeps
// the old shape and the INSERT below fails at runtime. Additive and idempotent.
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name));
  if (!cols.size) return;                       // fresh DB — DDL already made it right
  if (!cols.has('importance')) {
    db.exec('ALTER TABLE tasks ADD COLUMN importance INTEGER NOT NULL DEFAULT 2');
  }
  if (!cols.has('range_start')) {
    db.exec('ALTER TABLE tasks ADD COLUMN range_start INTEGER');
    db.exec('ALTER TABLE tasks ADD COLUMN range_end INTEGER');
  }
}

function ensureSchema(db) { db.exec(DDL); migrate(db); }

// IMPORTANCE IS DERIVED, NOT JUDGED. Nathan's formula:
//
//     importance = 1 + (deadline ? 1 : 0) + (actionable ? 1 : 0)
//
// where `actionable` means "the ball is in my court" — he can start now, nobody else has
// to move first. That is independent of size: "build the app" is actionable because
// nothing blocks it, while "donate once he sets up the page" is not.
//
// WHY DERIVED RATHER THAN ASKED FOR. A model rating 1-3 is making one fuzzy judgement; a
// model answering two yes/no questions is making two checkable ones. It also makes the
// number auditable — you can see WHY a task is a 3 — and if the weighting ever changes it
// is one line here, with every existing row re-deriving, instead of a prompt change and a
// re-extraction.
//
// Validated 8/8 against Nathan's own hand ratings once `actionable` was defined as
// blocked-or-not rather than specific-or-not. The earlier "cost of dropping it" rubric
// matched only 5/8 and disagreed with itself: three cases with identical inputs got
// different ratings.
function deriveImportance({ deadline, actionable }) {
  return 1 + (deadline ? 1 : 0) + (actionable ? 1 : 0);
}

// Kept for hand-edited rows and legacy values: the UI lets Nathan override the derived
// number, and an override must survive.
function normImportance(v) {
  const n = Number(v);
  return (n === 1 || n === 2 || n === 3) ? n : 2;
}

// THE TITLE IS PART OF THE KEY, and it has to be. This was `${slug}:m${msgId}` alone,
// which assumed one task per message. Nathan then reviewed a thread containing two
// separate asks and said "yes it should be two tasks" — and under the old key the second
// one collided with the first and `insertDraft` returned 'duplicate', silently dropping a
// real task. Losing a task he explicitly flagged is the worst failure this table has.
//
// The trade: a re-extraction that rewords a title produces a second row instead of
// deduping. That is visible and fixable; a silently dropped task is neither. It is also
// rare in practice — a cursor means each message is merged once, so the same trigger is
// normally only ever extracted a single time.
function taskKey(slug, msgId, title) {
  const h = crypto.createHash('sha1').update(String(title || ''), 'utf8').digest('hex').slice(0, 10);
  if (msgId) return `${slug}:m${msgId}:${h}`;
  return `${slug}:h${h}`;
}

// Insert an extracted commitment as a draft. Returns 'inserted' | 'duplicate'.
// ON CONFLICT DO NOTHING is the point: a key that already exists — even as
// 'dismissed' — is left exactly as it is, so a rejected task stays rejected.
function insertDraft(db, t) {
  ensureSchema(db);
  const key = taskKey(t.slug, t.msgId, t.title);
  const existing = db.prepare('SELECT id FROM tasks WHERE key = ?').get(key);
  if (existing) return 'duplicate';
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (key, slug, contact_name, status, owner, title, description,
                       deadline, confidence, importance, source_msg_id, range_start, range_end,
                       created_at, updated_at)
    VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    key, t.slug, t.contactName || null,
    OWNERS.has(t.owner) ? t.owner : 'nathan',
    String(t.title || '(untitled)').slice(0, 300),
    t.description ? String(t.description).slice(0, 2000) : null,
    t.deadline || null,
    // `confidence` is gone from the contract — it measured nothing (33% vs 25% precision
    // on a real eval, inverted in one variant). Column retained so old rows still read.
    null,
    t.importance == null ? deriveImportance(t) : normImportance(t.importance),
    t.msgId ?? null, t.rangeStart ?? null, t.rangeEnd ?? null, now, now,
  );
  return 'inserted';
}

function listByStatus(db, status) {
  ensureSchema(db);
  if (!STATUSES.has(status)) return [];
  // Importance first, then deadline. Nathan: "assign an importance score and have it
  // sort descending so it is easier to get the important ones." Undated tasks sort after
  // dated ones of the same importance rather than being pushed to the bottom outright.
  return db.prepare(
    'SELECT * FROM tasks WHERE status = ? ORDER BY importance DESC, (deadline IS NULL), deadline, id',
  ).all(status);
}

function counts(db) {
  ensureSchema(db);
  const out = { draft: 0, active: 0, done: 0, dismissed: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all()) {
    out[r.status] = r.n;
  }
  return out;
}

function getTask(db, id) {
  ensureSchema(db);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id)) || null;
}

function setStatus(db, id, status) {
  if (!STATUSES.has(status)) return;
  ensureSchema(db);
  const now = Date.now();
  db.prepare(`
    UPDATE tasks SET status = ?,
      accepted_at = CASE WHEN ? = 'active' AND accepted_at IS NULL THEN ? ELSE accepted_at END,
      done_at = CASE WHEN ? = 'done' THEN ? ELSE NULL END,
      updated_at = ?
    WHERE id = ?
  `).run(status, status, now, status, now, now, Number(id));
}

// Nathan's to edit: title, description, deadline, and now importance — the model's
// guess at how much something matters is exactly the kind of judgement he should be able
// to overrule. owner, source_msg_id and confidence stay immutable: "which message this
// came from" is worthless if it can be rewritten.
function updateTask(db, id, f) {
  ensureSchema(db);
  db.prepare('UPDATE tasks SET title = ?, description = ?, deadline = ?, importance = ?, updated_at = ? WHERE id = ?')
    .run(
      String(f.title || '(untitled)').slice(0, 300),
      f.description ? String(f.description).slice(0, 2000) : null,
      f.deadline ? String(f.deadline).slice(0, 20) : null,
      normImportance(f.importance),
      Date.now(), Number(id),
    );
}

// Hand-added task: no source message, immediately active.
function addManual(db, t) {
  ensureSchema(db);
  const now = Date.now();
  const key = `manual:${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO tasks (key, slug, contact_name, status, owner, title, description,
                       deadline, confidence, importance, source_msg_id, created_at, accepted_at, updated_at)
    VALUES (?,?,?,'active','nathan',?,?,?,NULL,?,NULL,?,?,?)
  `).run(
    key, t.slug || '', t.contactName || null,
    String(t.title || '(untitled)').slice(0, 300),
    t.description ? String(t.description).slice(0, 2000) : null,
    t.deadline || null, normImportance(t.importance), now, now, now,
  );
}

module.exports = {
  ensureSchema, taskKey, insertDraft, listByStatus, counts, getTask, setStatus,
  updateTask, addManual, normImportance, deriveImportance, OWNERS, STATUSES,
};
