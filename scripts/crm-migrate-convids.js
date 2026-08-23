'use strict';
// crm-migrate-convids.js — ONE-TIME migration that completes a secondary-device
// archive seed (the DUNA->MINMUS copy).
//
// THE PROBLEM IT FIXES. Signal Desktop's `conversationId` is a LOCALLY generated
// UUID — a fresh install (even one linked to the same account) invents its own
// ids. When this machine's archive was seeded by copying another device's crm.db,
// every copied row kept the ORIGIN device's conversationId. But resolveSources
// (lib/sources.js) resolves a contact's conversations against THIS machine's
// Signal DB, i.e. this machine's ids. So buildArchiveQuery's `conv_id IN (...)`
// filter never matches the copied rows, and the entire copied history is
// invisible to ingest/timeline — a contact would merge only the handful of
// messages this device swept for itself. The data is present; it is just
// unreachable by the source-rule queries.
//
// THE FIX. conversationId is device-local, but the things INSIDE a conversation
// are global: a DM is identified by the other party's serviceId, a group by its
// membership/name. So we bridge copied conv_ids to this machine's conv_ids:
//   - DM: the copied conv's dominant non-me sender serviceId -> this machine's
//     private conversation for that serviceId.
//   - group: exact name match, else membership overlap.
// Then rewrite the copied rows' conv_id to the local id. Only conv_id (metadata,
// like backfillMeta's src/type) changes; message ids/bodies/citations are
// untouched, so provenance stays intact. Idempotent (already-local rows are
// skipped) and refuses to touch anything if ANY copied conversation is ambiguous.
//
// Copied rows are the id<OFFSET band (see lib/config CRM_ARCHIVE_ID_OFFSET); rows
// this machine swept itself already carry local conv_ids and are left alone.
//
//   node scripts/crm-migrate-convids.js            # dry run: print the mapping
//   node scripts/crm-migrate-convids.js --apply     # back up, then rewrite
const { MY_SERVICE_ID, BOT_SERVICE_ID, ARCHIVE_ID_OFFSET, CRM_DB } = require('../lib/config');
const { openCrmDb, openSignalDb } = require('../lib/signal-db');

const COPIED_MAX = ARCHIVE_ID_OFFSET || 100_000_000; // copied rows live below the offset band

function buildMapping(cdb, sdb) {
  const rows = cdb.prepare(
    `SELECT conv_id, conversation AS label, src, COUNT(*) n
     FROM messages WHERE id < ? GROUP BY conv_id, src`).all(COPIED_MAX);
  const copied = new Map();
  for (const r of rows) {
    let c = copied.get(r.conv_id);
    if (!c) { c = { conv_id: r.conv_id, label: r.label, n: 0, srcs: {} }; copied.set(r.conv_id, c); }
    c.n += r.n;
    const k = r.src == null ? 'NULL' : r.src;
    c.srcs[k] = (c.srcs[k] || 0) + r.n;
  }

  const convs = sdb.prepare('SELECT id, serviceId, type, name, members FROM conversations').all();
  const localIds = new Set(convs.map((c) => c.id));
  const privBySid = new Map();
  const groups = [];
  for (const c of convs) {
    if (c.type === 'private' && c.serviceId) privBySid.set(c.serviceId, c.id);
    if (c.type === 'group') groups.push({ id: c.id, name: c.name || '', members: (c.members || '').split(/\s+/).filter(Boolean) });
  }

  const mapping = []; const unmapped = [];
  for (const c of copied.values()) {
    if (localIds.has(c.conv_id)) continue; // already a local id (idempotent / self-swept)
    const nonMe = Object.keys(c.srcs).filter((s) => s !== 'NULL' && s !== MY_SERVICE_ID && s !== BOT_SERVICE_ID);
    let target = null; let how = null;
    const looksDm = /^DM with/i.test(c.label || '');
    if (looksDm && nonMe.length) {
      const dom = nonMe.slice().sort((a, b) => c.srcs[b] - c.srcs[a])[0];
      if (privBySid.has(dom)) { target = privBySid.get(dom); how = `DM ${dom.slice(0, 8)}`; }
    }
    if (!target) {
      const byName = groups.filter((g) => g.name && g.name === c.label);
      if (byName.length === 1) { target = byName[0].id; how = 'group name'; }
      else {
        const ov = groups.map((g) => ({ g, o: nonMe.filter((s) => g.members.includes(s)).length }))
          .filter((x) => x.o > 0).sort((a, b) => b.o - a.o);
        if (ov.length === 1 || (ov.length > 1 && ov[0].o > ov[1].o)) { target = ov[0].g.id; how = `group members(${ov[0].o})`; }
      }
    }
    const rec = { conv_id: c.conv_id, label: c.label, n: c.n, target, how };
    (target ? mapping : unmapped).push(rec);
  }
  mapping.sort((a, b) => b.n - a.n);
  return { mapping, unmapped, localIds };
}

function main() {
  const apply = process.argv.includes('--apply');
  const cdb = openCrmDb();
  const sdb = openSignalDb();
  const { mapping, unmapped } = buildMapping(cdb, sdb);

  const sum = (a) => a.reduce((n, r) => n + r.n, 0);
  console.log(`copied-band conv remap: ${mapping.length} mappable (${sum(mapping)} msgs), ${unmapped.length} UNMAPPED (${sum(unmapped)} msgs)`);
  for (const m of mapping) console.log(`  ${String(m.n).padStart(6)}  ${m.how.padEnd(16)} ${m.label}  ${m.conv_id.slice(0, 8)}->${m.target.slice(0, 8)}`);
  for (const m of unmapped) console.log(`  UNMAPPED ${String(m.n).padStart(6)}  ${m.label}  ${m.conv_id}`);

  if (unmapped.length) { console.error('\nABORT: some copied conversations are ambiguous; refusing to touch the archive.'); sdb.close(); cdb.close(); process.exit(2); }
  if (!apply) { console.log('\n(dry run — pass --apply to back up and rewrite)'); sdb.close(); cdb.close(); return; }

  const bak = `${CRM_DB}.pre-convid-remap.bak`;
  console.log(`\nbacking up -> ${bak}`);
  cdb.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);

  const upd = cdb.prepare('UPDATE messages SET conv_id = ? WHERE conv_id = ? AND id < ?');
  let changed = 0;
  cdb.exec('BEGIN');
  try {
    for (const m of mapping) changed += upd.run(m.target, m.conv_id, COPIED_MAX).changes;
    cdb.exec('COMMIT');
  } catch (e) { cdb.exec('ROLLBACK'); throw e; }
  console.log(`rewrote conv_id on ${changed} copied rows.`);

  // verify: no copied row keeps a conv_id that this machine's Signal DB doesn't know
  const localIds = new Set(sdb.prepare('SELECT id FROM conversations').all().map((r) => r.id));
  const orphans = cdb.prepare('SELECT DISTINCT conv_id FROM messages WHERE id < ?').all(COPIED_MAX)
    .filter((r) => !localIds.has(r.conv_id));
  console.log(orphans.length ? `WARNING: ${orphans.length} copied conv_id(s) still not local` : 'verify OK: every copied conv_id is now a local Signal conversation.');
  sdb.close(); cdb.close();
}

if (require.main === module) main();
module.exports = { buildMapping };
