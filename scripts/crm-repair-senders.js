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
// THE REPAIR: for every archived message that still carries a `src` (serviceId) —
// group messages AND DMs — recompute the correct speaker from `src`, exactly as the
// sweep would, and rewrite `sender` where it currently names the wrong person. A
// tracked person's own line is written by FIRST name (DM or their words in a group);
// only an untracked third party in a group keeps their full name. Only the `sender`
// LABEL column is touched; message bodies, ids, and everything else are left exactly
// as-is. Rows whose `src` is NULL (legacy, un-inferable) or that already name the
// right person (by full or first name) are left alone, so this is safe to re-run and
// is a no-op once clean.
//
// SAFE BY DEFAULT — dry-run unless --write. It prints every from→to relabel it
// would make, grouped by pair, so you can eyeball it before applying. BACK UP
// crm.db first (node scripts/crm-backup.js) — this writes the append-only archive.
//
//   node scripts/crm-repair-senders.js            # preview (dry-run)
//   node scripts/crm-repair-senders.js --write     # apply
const { openCrmDb, openSignalDb } = require('../lib/signal-db');
const { MY_SERVICE_ID, BOT_SERVICE_ID } = require('../lib/config');
const { signalNameMap: buildNameMap } = require('../lib/signal-names');

const WRITE = process.argv.includes('--write');

// Speaker names resolve exactly as the sweep freezes them (lib/signal-names):
// Signal nickname, then iPhone contact name, then their profile name, then phone
// number. Re-running this after the resolver changed is how the old profile-name
// labels ("fingersix") get rewritten to the nickname ("Darren Pai").

function main() {
  const cdb = openCrmDb();
  const sdb = openSignalDb();
  const nameMap = buildNameMap(sdb);
  // GROUP conversationIds (bi- and multi- alike). A group third party is labeled by
  // FULL name; a DM sender (and a contact's own group line) by FIRST name — the same
  // split the sweep writes (crm-archive.sweepContact). We now repair BOTH: a wrong
  // Signal PROFILE name ("fingersix") baked into a DM before the resolver changed is
  // exactly what this rewrites to the nickname.
  const groupConvIds = new Set(
    sdb.prepare("SELECT id FROM conversations WHERE type='group'").all().map((r) => r.id),
  );
  sdb.close();

  // The serviceIds we track. A tracked person's own line is labeled by FIRST name
  // wherever it appears (their DM, or their own words in a group) so their labels
  // read uniformly across the archive; only an UNTRACKED third party in a group
  // keeps their full name. This matches the sweep, which labels a contact's own
  // line by first name (crm-archive.sweepContact) and a stranger by full name.
  const trackedSignalIds = new Set(
    cdb.prepare('SELECT signal_id FROM contacts WHERE signal_id IS NOT NULL').all().map((r) => r.signal_id),
  );

  const firstWord = (s) => String(s).split(' ')[0];
  const rows = cdb.prepare('SELECT id, conv_id, src, sender, type FROM messages WHERE src IS NOT NULL').all();
  const fixes = [];
  for (const r of rows) {
    let full;
    if (r.type === 'outgoing' || r.src === MY_SERVICE_ID) full = 'Nathan';
    else if (r.src === BOT_SERVICE_ID) full = 'Janet';
    else full = nameMap.get(r.src) || null;
    if (!full) continue;                                       // src not resolvable — leave it
    // Either the full or the first-name form is an acceptable, already-correct label.
    if (r.sender === full || r.sender === firstWord(full)) continue;
    // Write it the way the sweep would: a tracked person's own line (DM or their words
    // in a group) uses the first name; only an untracked third party in a group keeps
    // their full name so shared-group lines stay unambiguous.
    const isGroup = groupConvIds.has(r.conv_id);
    const isThirdParty = isGroup && r.src !== MY_SERVICE_ID && !trackedSignalIds.has(r.src);
    const correct = isThirdParty ? full : firstWord(full);
    if (r.sender === correct) continue;
    fixes.push({ id: r.id, from: r.sender, to: correct });
  }

  console.log(`crm-repair-senders: ${WRITE ? 'WRITE' : 'DRY-RUN'} | ${fixes.length} row(s) to relabel (of ${rows.length} with a src)`);
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

if (require.main === module) {
  // Cross-process pipeline lock: this rewrites crm.db's messages table and must
  // not overlap a sweep or ingest run.
  const lock = require('../lib/pipeline-lock').acquire('repair-senders');
  if (!lock.ok) { console.log(`crm-repair-senders: skipped, run in progress (${lock.holderDesc}).`); process.exit(0); }
  try { main(); }
  finally { lock.release(); }
}
