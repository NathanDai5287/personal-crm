'use strict';
// lib/tasks.js — drafts, then owned todos.
//
// TWO STAGES, on purpose:
//
//   DRAFT   Derived on the fly from each profile's `## Talking points`. Not stored.
//           An ingest run produces these as a side effect of merging; they are
//           candidates, and most of them are not things Nathan will actually do.
//
//   ACTIVE  A row in `tasks`, created when Nathan accepts a draft. From that moment
//           the ROW is authoritative and the profile text is only its origin: title,
//           description and deadline are his to edit, and a later merge rewording
//           the bullet must not overwrite them.
//
// That split is the whole design. Editing a derived value is meaningless because the
// next merge regenerates it; editing an owned row is durable.
//
// THE DEDUPE KEY. A draft is suppressed once a task (or a dismissal) exists for it.
// Keyed on the bullet's FIRST citation id, because merge.md's carry-forward rule
// requires that id to survive a rewrite while the claim stands — the bullet text
// will not. Uncited bullets fall back to a text hash and will re-appear as a fresh
// draft if reworded; accepted, since the alternative is re-drafting on every merge.

const crypto = require('crypto');

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  slug TEXT NOT NULL,
  contact_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active | done | dismissed
  title TEXT NOT NULL,
  description TEXT,
  deadline TEXT,                           -- YYYY-MM-DD or YYYY-MM, free-form-ish
  source_msg_id INTEGER,                   -- the message that triggered it
  source_msg_ids TEXT,                     -- all cited ids, comma separated
  origin_text TEXT,                        -- the talking-point bullet as written
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  done_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_slug ON tasks(slug);
`;

function ensureSchema(db) { db.exec(DDL); }

function citedIds(text) {
  const out = [];
  for (const g of String(text).match(/⟨\s*m\d+(?:\s*,\s*m\d+)*\s*⟩/g) || []) {
    for (const m of g.matchAll(/m(\d+)/g)) out.push(Number(m[1]));
  }
  return [...new Set(out)];
}

function taskKey(slug, text) {
  const ids = citedIds(text);
  if (ids.length) return `${slug}:m${ids[0]}`;
  return `${slug}:h${crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 12)}`;
}

// Talking points read as "<action> — <context>". The action is the title; the rest
// is the description. Falls back to the first sentence (including ? and !, since
// many talking points are literally questions), then a hard truncation.
function splitTask(text) {
  const clean = String(text)
    .replace(/⟨\s*m\d+(?:\s*,\s*m\d+)*\s*⟩/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const dash = clean.search(/\s+[—–]\s+/);
  if (dash > 12) {
    return {
      title: clean.slice(0, dash).trim().replace(/[.,;:]$/, ''),
      description: clean.slice(dash).replace(/^\s*[—–]\s*/, '').trim(),
    };
  }
  const stop = clean.search(/[.;?!]\s/);
  if (stop > 12) return { title: clean.slice(0, stop + 1).trim(), description: clean.slice(stop + 2).trim() };
  if (clean.length > 96) return { title: `${clean.slice(0, 95).trimEnd()}…`, description: clean };
  return { title: clean, description: '' };
}

// Build a draft from a talking point. Not stored until accepted.
function draftFrom(slug, name, tp) {
  const { title, description } = splitTask(tp.text);
  const ids = citedIds(tp.text);
  return {
    key: taskKey(slug, tp.text),
    slug,
    contactName: name,
    title,
    description,
    deadline: tp.date || null,
    sourceMsgId: ids.length ? ids[0] : null,
    sourceMsgIds: ids,
    originText: tp.text,
  };
}

function listTasks(db, status = null) {
  ensureSchema(db);
  const rows = status
    ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY (deadline IS NULL), deadline, id').all(status)
    : db.prepare('SELECT * FROM tasks ORDER BY (deadline IS NULL), deadline, id').all();
  return rows;
}

// Every key already spoken for — accepted OR dismissed. Dismissed keys must be
// included or a rejected draft returns on the next page load.
function knownKeys(db) {
  ensureSchema(db);
  const s = new Set();
  for (const r of db.prepare('SELECT key FROM tasks').all()) s.add(r.key);
  return s;
}

function acceptDraft(db, d) {
  ensureSchema(db);
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (key, slug, contact_name, status, title, description, deadline,
                       source_msg_id, source_msg_ids, origin_text, created_at, accepted_at, updated_at)
    VALUES (?,?,?,'active',?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO NOTHING
  `).run(
    d.key, d.slug, d.contactName || null, d.title || '(untitled)', d.description || null,
    d.deadline || null, d.sourceMsgId ?? null, (d.sourceMsgIds || []).join(','),
    d.originText || null, now, now, now,
  );
  return db.prepare('SELECT * FROM tasks WHERE key = ?').get(d.key) || null;
}

function dismissDraft(db, d) {
  ensureSchema(db);
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (key, slug, contact_name, status, title, description, deadline,
                       source_msg_id, source_msg_ids, origin_text, created_at, updated_at)
    VALUES (?,?,?,'dismissed',?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET status='dismissed', updated_at=excluded.updated_at
  `).run(
    d.key, d.slug, d.contactName || null, d.title || '(untitled)', d.description || null,
    d.deadline || null, d.sourceMsgId ?? null, (d.sourceMsgIds || []).join(','),
    d.originText || null, now, now,
  );
}

function setDone(db, id, done) {
  ensureSchema(db);
  db.prepare('UPDATE tasks SET status = ?, done_at = ?, updated_at = ? WHERE id = ?')
    .run(done ? 'done' : 'active', done ? Date.now() : null, Date.now(), Number(id));
}

function updateTask(db, id, fields) {
  ensureSchema(db);
  // Only these three are Nathan's to edit. Origin and provenance are immutable —
  // the whole point of showing "which message triggered this" is that it cannot be
  // quietly rewritten.
  db.prepare('UPDATE tasks SET title = ?, description = ?, deadline = ?, updated_at = ? WHERE id = ?')
    .run(
      String(fields.title || '(untitled)').slice(0, 300),
      fields.description ? String(fields.description).slice(0, 2000) : null,
      fields.deadline ? String(fields.deadline).slice(0, 20) : null,
      Date.now(), Number(id),
    );
}

function getTask(db, id) {
  ensureSchema(db);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id)) || null;
}

module.exports = {
  ensureSchema, taskKey, splitTask, citedIds, draftFrom,
  listTasks, knownKeys, acceptDraft, dismissDraft, setDone, updateTask, getTask,
};
