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
// Extracted by scripts/crm-tasks.js from the same ledger the merge reads, via
// prompts/tasks.md, and written straight into this table.
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
// THE DEDUPE KEY is slug + the message id that created the commitment. That id is
// immutable (it names an archived message), so re-running extraction over the same
// or overlapping ledgers cannot duplicate a task or resurrect a dismissed one.

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
  confidence TEXT,                         -- explicit | probable
  source_msg_id INTEGER,                   -- the message where it was agreed
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  done_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_slug ON tasks(slug);
`;

function ensureSchema(db) { db.exec(DDL); }

function taskKey(slug, msgId, title) {
  if (msgId) return `${slug}:m${msgId}`;
  // No id should be impossible (the prompt requires one) but a title hash keeps a
  // malformed extraction from colliding with a real task.
  return `${slug}:h${crypto.createHash('sha1').update(String(title || ''), 'utf8').digest('hex').slice(0, 12)}`;
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
                       deadline, confidence, source_msg_id, created_at, updated_at)
    VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?)
  `).run(
    key, t.slug, t.contactName || null,
    OWNERS.has(t.owner) ? t.owner : 'nathan',
    String(t.title || '(untitled)').slice(0, 300),
    t.description ? String(t.description).slice(0, 2000) : null,
    t.deadline || null,
    t.confidence === 'probable' ? 'probable' : 'explicit',
    t.msgId ?? null, now, now,
  );
  return 'inserted';
}

function listByStatus(db, status) {
  ensureSchema(db);
  if (!STATUSES.has(status)) return [];
  return db.prepare(
    'SELECT * FROM tasks WHERE status = ? ORDER BY (deadline IS NULL), deadline, id',
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

// Only these three are Nathan's to edit. owner, source_msg_id and confidence are
// immutable — "which message this came from" is worthless if it can be rewritten.
function updateTask(db, id, f) {
  ensureSchema(db);
  db.prepare('UPDATE tasks SET title = ?, description = ?, deadline = ?, updated_at = ? WHERE id = ?')
    .run(
      String(f.title || '(untitled)').slice(0, 300),
      f.description ? String(f.description).slice(0, 2000) : null,
      f.deadline ? String(f.deadline).slice(0, 20) : null,
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
                       deadline, confidence, source_msg_id, created_at, accepted_at, updated_at)
    VALUES (?,?,?,'active','nathan',?,?,?,NULL,NULL,?,?,?)
  `).run(
    key, t.slug || '', t.contactName || null,
    String(t.title || '(untitled)').slice(0, 300),
    t.description ? String(t.description).slice(0, 2000) : null,
    t.deadline || null, now, now, now,
  );
}

module.exports = {
  ensureSchema, taskKey, insertDraft, listByStatus, counts,
  getTask, setStatus, updateTask, addManual, OWNERS, STATUSES,
};
