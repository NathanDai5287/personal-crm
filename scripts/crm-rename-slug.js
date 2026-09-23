'use strict';
// crm-rename-slug.js — rename a tracked person's SLUG (their stable identifier), which
// is distinct from their display NAME (the Signal nickname owns that, and is not editable
// here). A slug is normally immutable; this exists for the rare case where a person was
// promoted under an ugly auto-slug (e.g. 'p' for Param Sehrawat) and you want it fixed.
//
// It rewrites every slug reference atomically: the profile file, crm-tracked.json, and
// every slug-bearing column in crm.db (contacts.file_path, facts.slug, mentions.from/to,
// mention_reassign.from/orig/new, messages.contact_slug, merged.slug). Mentions are also
// rebuilt deterministically by the next sweep, but they are rewritten here too so the
// graph is consistent immediately.
//
// SAFE BY DEFAULT — dry-run unless --write. BACK UP crm.db first
// (node scripts/crm-backup.js). Run on the SERVING machine (minmus).
//
//   node scripts/crm-rename-slug.js <old-slug> <new-slug>            # preview
//   node scripts/crm-rename-slug.js <old-slug> <new-slug> --write    # apply
const fs = require('fs');
const path = require('path');
const { openCrmDb } = require('../lib/signal-db');
const { CONTACTS_DIR, TRACKED } = require('../lib/config');

const args = process.argv.slice(2).filter((a) => a !== '--write');
const WRITE = process.argv.includes('--write');
const [oldSlug, newSlug] = args;

function safe(s) { return typeof s === 'string' && /^[a-z0-9._-]+$/i.test(s) && !s.includes('..'); }

// The slug-keyed stores OUTSIDE crm.db. Missing any of these is not cosmetic: the todo
// cursor lost would make the next todo scan re-read the person's whole history (paid),
// the archive cursor lost re-walks them, the Timeline state lost resets their `since`,
// and the nickname rows would orphan under a slug that no longer exists. `apply` false =
// report only. Returns one description line per store touched.
function renameSideStores(apply) {
  const { DATA_DIR, REFRESH_DIR, ARCHIVE_STATE, TIMELINE_STATE, NICKNAMES_DB } = require('../lib/config');
  const out = [];
  // JSON state: rename every object key equal to the slug (or "contact:<slug>"), at any depth.
  const renameKeys = (v) => {
    let n = 0;
    const walk = (o) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
      const next = {};
      for (const [k, val] of Object.entries(o)) {
        const nk = k === oldSlug ? newSlug : k === `contact:${oldSlug}` ? `contact:${newSlug}` : k;
        if (nk !== k) n += 1;
        next[nk] = walk(val);
      }
      return next;
    };
    return { value: walk(v), n };
  };
  const jsonFiles = [ARCHIVE_STATE, TIMELINE_STATE, path.join(DATA_DIR, 'crm-todo-state.json'), path.join(DATA_DIR, 'merge-holds.json')];
  for (const f of jsonFiles) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const { value, n } = renameKeys(raw);
    if (!n) continue;
    if (apply) { const tmp = `${f}.tmp-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(tmp, f); }
    out.push(`${path.basename(f)}: ${n} key(s)`);
  }
  // Nicknames live in their own database.
  try {
    if (fs.existsSync(NICKNAMES_DB)) {
      const { DatabaseSync } = require('node:sqlite');
      const ndb = new DatabaseSync(NICKNAMES_DB);
      try {
        for (const t of ['nickname', 'nickname_rejected']) {
          let n = 0;
          try { n = ndb.prepare(`SELECT COUNT(*) n FROM ${t} WHERE slug = ?`).get(oldSlug).n; } catch { continue; }
          if (!n) continue;
          if (apply) ndb.prepare(`UPDATE ${t} SET slug = ? WHERE slug = ?`).run(newSlug, oldSlug);
          out.push(`crm-nicknames.db ${t}: ${n} row(s)`);
        }
      } finally { ndb.close(); }
    }
  } catch (e) { out.push(`crm-nicknames.db: FAILED (${e.message})`); }
  // Per-slug files: the ledger scratch (_refresh/<slug>.*) and a censor-review hold.
  const moves = [];
  try { for (const f of fs.readdirSync(REFRESH_DIR)) if (f.startsWith(`${oldSlug}.`)) moves.push([path.join(REFRESH_DIR, f), path.join(REFRESH_DIR, newSlug + f.slice(oldSlug.length))]); } catch { /* none */ }
  const held = path.join(DATA_DIR, 'censor-review', `${oldSlug}.txt`);
  if (fs.existsSync(held)) moves.push([held, path.join(DATA_DIR, 'censor-review', `${newSlug}.txt`)]);
  for (const [a, b] of moves) {
    if (apply) fs.renameSync(a, b);
    out.push(`file: ${path.relative(DATA_DIR, a)} -> ${path.basename(b)}`);
  }
  return out;
}

function main() {
  if (!oldSlug || !newSlug) { console.error('usage: crm-rename-slug <old-slug> <new-slug> [--write]'); process.exit(1); }
  if (!safe(oldSlug) || !safe(newSlug)) { console.error('slugs must match /^[a-z0-9._-]+$/ and contain no ".."'); process.exit(1); }
  if (oldSlug === newSlug) { console.error('old and new slug are the same'); process.exit(1); }

  const oldMd = path.join(CONTACTS_DIR, `${oldSlug}.md`);
  const newMd = path.join(CONTACTS_DIR, `${newSlug}.md`);
  if (!fs.existsSync(oldMd)) { console.error(`no profile at ${oldMd} — is "${oldSlug}" a tracked person?`); process.exit(1); }
  if (fs.existsSync(newMd)) { console.error(`a profile already exists at ${newMd} — pick a free slug`); process.exit(1); }

  const oldRel = `data/contacts/${oldSlug}.md`;
  const newRel = `data/contacts/${newSlug}.md`;

  const cdb = openCrmDb();
  // Count what would change, per table (guarded — a table/column may not exist yet).
  const count = (sql, ...p) => { try { return cdb.prepare(sql).get(...p).n; } catch { return 0; } };
  const plan = {
    contacts: count('SELECT COUNT(*) n FROM contacts WHERE file_path = ?', oldRel),
    facts: count('SELECT COUNT(*) n FROM facts WHERE slug = ?', oldSlug),
    mentions: count('SELECT COUNT(*) n FROM mentions WHERE from_slug = ? OR to_slug = ?', oldSlug, oldSlug),
    mention_reassign: count('SELECT COUNT(*) n FROM mention_reassign WHERE from_slug = ? OR orig_to = ? OR new_to = ?', oldSlug, oldSlug, oldSlug),
    messages: count('SELECT COUNT(*) n FROM messages WHERE contact_slug = ?', oldSlug),
    merged: count('SELECT COUNT(*) n FROM merged WHERE slug = ?', oldSlug),
  };
  const trackedRaw = (() => { try { return JSON.parse(fs.readFileSync(TRACKED, 'utf8')); } catch { return { slugs: [] }; } })();
  const inTracked = Array.isArray(trackedRaw.slugs) && trackedRaw.slugs.includes(oldSlug);

  console.log(`crm-rename-slug: ${WRITE ? 'WRITE' : 'DRY-RUN'} | ${oldSlug} -> ${newSlug}`);
  console.log(`  profile file: ${oldRel} -> ${newRel}`);
  console.log(`  crm-tracked.json: ${inTracked ? 'slug present, will rewrite' : 'slug NOT in tracked.json'}`);
  for (const [t, n] of Object.entries(plan)) console.log(`  ${t}: ${n} row(s)`);

  const factKeys = count('SELECT COUNT(*) n FROM facts WHERE substr(identity_key, 1, ?) = ?', oldSlug.length + 1, `${oldSlug}|`);
  console.log(`  facts.identity_key: ${factKeys} row(s)`);
  if (!WRITE) for (const line of renameSideStores(false)) console.log(`  ${line}`);

  if (!WRITE) {
    console.log('\nDry-run — nothing changed. Back up crm.db (node scripts/crm-backup.js), then re-run with --write.');
    cdb.close();
    return;
  }

  // Take the pipeline lock so a concurrent sweep can't reconcile/rebuild against a
  // half-renamed state (file moved but the DB not yet updated, or vice versa).
  const lock = require('../lib/pipeline-lock').acquire('rename-slug');
  if (!lock.ok) {
    console.error(`crm-rename-slug: skipped, a pipeline run is in progress (${lock.holderDesc}). Try again when idle.`);
    cdb.close();
    process.exit(1);
  }
  try {
  // FS first so a DB failure leaves a clean rollback target; if the DB txn throws we move
  // the file back. tracked.json is rewritten last (cheap, idempotent).
  fs.renameSync(oldMd, newMd);
  try {
    cdb.exec('BEGIN IMMEDIATE');
    try {
      const run = (sql, ...p) => { try { cdb.prepare(sql).run(...p); } catch (e) { if (!/no such table|no such column/i.test(e.message)) throw e; } };
      run('UPDATE contacts SET file_path = ? WHERE file_path = ?', newRel, oldRel);
      run('UPDATE facts SET slug = ? WHERE slug = ?', newSlug, oldSlug);
      // identity_key embeds the slug ("<slug>|<field>…", lib/schema identityKey); a stale
      // prefix would split every fact's supersession chain in two.
      run('UPDATE facts SET identity_key = ? || substr(identity_key, ?) WHERE substr(identity_key, 1, ?) = ?',
        newSlug, oldSlug.length + 1, oldSlug.length + 1, `${oldSlug}|`);
      run('UPDATE mentions SET from_slug = ? WHERE from_slug = ?', newSlug, oldSlug);
      run('UPDATE mentions SET to_slug = ? WHERE to_slug = ?', newSlug, oldSlug);
      run('UPDATE mention_reassign SET from_slug = ? WHERE from_slug = ?', newSlug, oldSlug);
      run('UPDATE mention_reassign SET orig_to = ? WHERE orig_to = ?', newSlug, oldSlug);
      run('UPDATE mention_reassign SET new_to = ? WHERE new_to = ?', newSlug, oldSlug);
      run('UPDATE messages SET contact_slug = ? WHERE contact_slug = ?', newSlug, oldSlug);
      run('UPDATE merged SET slug = ? WHERE slug = ?', newSlug, oldSlug);
      cdb.exec('COMMIT');
    } catch (e) {
      cdb.exec('ROLLBACK');
      throw e;
    }
  } catch (e) {
    try { fs.renameSync(newMd, oldMd); } catch { /* best-effort restore */ }
    cdb.close();
    lock.release();
    console.error(`crm-rename-slug: FAILED, rolled back (${e.message}).`);
    process.exit(1);
  }
  cdb.close();

  if (inTracked) {
    trackedRaw.slugs = trackedRaw.slugs.map((s) => (s === oldSlug ? newSlug : s));
    fs.writeFileSync(TRACKED, `${JSON.stringify(trackedRaw, null, 2)}\n`);
  }
  for (const line of renameSideStores(WRITE)) console.log(`  ${line}`);
  console.log(`crm-rename-slug: done. ${oldSlug} -> ${newSlug}. Run a sweep (node scripts/crm-archive.js) to rebuild derived state.`);
  } finally { lock.release(); }
}

main();
