'use strict';
// crm-repair-senders.js — ONE-TIME repair for the group speaker-attribution bug.
//
// THE BUG (now fixed at sweep time in crm-archive.js): the per-contact sweep
// labeled EVERY non-Nathan/non-bot speaker in a contact's multi-groups with THAT
// CONTACT's name. Because contacts are swept before groups and the archive is
// INSERT OR IGNORE (id-keyed, never updated), a third party's message in a shared
// group got frozen under the tracked contact's name — e.g. Vlad's line stored as
// "Katia" in Katia's group. Those frozen rows feed merges, so the wrong name can
// end up in a profile.
//
// THE REPAIR: for every archived GROUP message that still carries a `src`
// (serviceId), recompute the correct speaker from `src` — exactly as the group
// sweep would — and rewrite `sender` where it currently names the wrong person.
// Only the `sender` LABEL column is touched; message bodies, ids, and everything
// else are left exactly as-is, and DMs are never touched. Rows whose `src` is NULL
// (legacy, un-inferable) or that already name the right person (by full or first
// name) are left alone, so this is safe to re-run and is a no-op once clean.
//
// SAFE BY DEFAULT — dry-run unless --write. It prints every from→to relabel it
// would make, grouped by pair, so you can eyeball it before applying. BACK UP
// crm.db first (node scripts/crm-backup.js) — this writes the append-only archive.
//
//   node scripts/crm-repair-senders.js            # preview (dry-run)
//   node scripts/crm-repair-senders.js --write     # apply
const fs = require('fs');
const { openCrmDb, openSignalDb } = require('../lib/signal-db');
const { MY_SERVICE_ID, BOT_SERVICE_ID, DISPLAY_NAMES } = require('../lib/config');

const WRITE = process.argv.includes('--write');

// Same resolution as crm-archive.buildNameMap: Signal names, overridden by
// Nathan's display-name overrides (crm-display-names.json).
function buildNameMap(sdb) {
  let nicks = {};
  try { nicks = JSON.parse(fs.readFileSync(DISPLAY_NAMES, 'utf8')).byServiceId || {}; } catch { /* none */ }
  const m = new Map();
  for (const r of sdb.prepare(
    "SELECT serviceId, COALESCE(name, profileFullName, profileName, e164) AS nm FROM conversations WHERE type='private' AND serviceId IS NOT NULL",
  ).all()) if (r.nm) m.set(r.serviceId, r.nm);
  for (const [sid, info] of Object.entries(nicks)) if (info && info.name) m.set(sid, info.name);
  return m;
}

function main() {
  const cdb = openCrmDb();
  const sdb = openSignalDb();
  const nameMap = buildNameMap(sdb);
  // Every GROUP conversationId (bi- and multi- alike). Only rows in these convs
  // can carry a mislabeled third-party speaker; DMs are single-party and correct.
  const groupConvIds = new Set(
    sdb.prepare("SELECT id FROM conversations WHERE type='group'").all().map((r) => r.id),
  );
  sdb.close();

  const firstWord = (s) => String(s).split(' ')[0];
  const rows = cdb.prepare('SELECT id, conv_id, src, sender, type FROM messages WHERE src IS NOT NULL').all();
  const fixes = [];
  for (const r of rows) {
    if (!groupConvIds.has(r.conv_id)) continue;
    let correct;
    if (r.type === 'outgoing' || r.src === MY_SERVICE_ID) correct = 'Nathan';
    else if (r.src === BOT_SERVICE_ID) correct = 'Janet';
    else correct = nameMap.get(r.src) || null;
    if (!correct) continue;                                   // src not resolvable — leave it
    if (r.sender === correct || r.sender === firstWord(correct)) continue; // already right
    fixes.push({ id: r.id, from: r.sender, to: correct });
  }

  console.log(`crm-repair-senders: ${WRITE ? 'WRITE' : 'DRY-RUN'} | ${fixes.length} group row(s) to relabel (of ${rows.length} with a src)`);
  const byPair = new Map();
  for (const f of fixes) { const k = `${f.from}  ->  ${f.to}`; byPair.set(k, (byPair.get(k) || 0) + 1); }
  for (const [k, n] of [...byPair.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
  if (byPair.size > 40) console.log(`  … ${byPair.size - 40} more distinct relabels`);

  if (!WRITE) {
    console.log('\nDry-run — nothing changed. Back up crm.db (node scripts/crm-backup.js), then re-run with --write.');
    cdb.close();
    return;
  }
  if (fixes.length) {
    const upd = cdb.prepare('UPDATE messages SET sender = ? WHERE id = ?');
    cdb.exec('BEGIN');
    try { for (const f of fixes) upd.run(f.to, f.id); cdb.exec('COMMIT'); }
    catch (e) { cdb.exec('ROLLBACK'); cdb.close(); throw e; }
    console.log(`crm-repair-senders: relabeled ${fixes.length} row(s). Message bodies/ids untouched.`);
  } else {
    console.log('crm-repair-senders: nothing to do — archive senders already correct.');
  }
  cdb.close();
}

main();
