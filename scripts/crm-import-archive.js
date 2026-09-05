'use strict';
// scripts/crm-import-archive.js — one-time UNION import of a SECOND machine's archive.
//
//   node scripts/crm-import-archive.js <source-crm.db>            # dry run (default): report only
//   node scripts/crm-import-archive.js <source-crm.db> --write    # apply the import
//
// WHY. DUNA (Windows desktop) and MINMUS (server) each ran their own Signal Desktop and
// built INDEPENDENT crm.db archives (see docs/ENGINEERING-LOG "the minmus deployment").
// Neither is a subset of the other — each Desktop captured messages/calls the other missed
// (calls are device-local; outgoing/disappearing messages diverge). This folds the SOURCE
// archive's missing messages into the TARGET (local) archive so the target becomes the union.
//
// DEDUP is by `sent_at` — Signal's send-instant, identical on every device for the same
// message. Everything else drifts per machine and is NOT a reliable cross-machine identity:
// body/sender/enrichment (built by possibly-different code), `type`, `src` (NULL on ~19% of
// legacy rows), and the row `id`. A source row whose sent_at already exists in the target is
// skipped. (Two genuinely-different messages sharing a millisecond is vanishingly rare — a
// handful of intra-DB collisions exist — so at worst we skip importing one such twin, never
// duplicate an existing message.)
//
// TWO per-machine identifiers cannot be carried across verbatim:
//   - `id`: the CRM_ARCHIVE_ID_OFFSET (+100M) was applied only to LATER minmus sweeps, so
//     the id spaces OVERLAP (both start at 748). Imported rows get FRESH ids above the
//     target's current MAX(id), so nothing collides and no existing citation is disturbed.
//   - `conv_id`: Signal assigns a different conversationId per install (observed: 0 overlap).
//     We REMAP source→target conv_id by majority vote over SHARED messages (same sent_at in
//     both archives ⇒ same conversation). A source conv_id with no shared message maps to
//     NULL (slug-based ingest still works; only conv_id group-context is affected).
//
// crm.db is append-only and IRREPLACEABLE. This only INSERTs, wraps the work in a
// transaction, and takes the pipeline lock so a sweep can't interleave. BACK IT UP FIRST.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { CRM_DB } = require('../lib/config');
const { openCrmDb } = require('../lib/signal-db');
const { ensureMessagesTable } = require('../lib/archive');

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const src = argv.find((a) => !a.startsWith('--'));
  if (!src) { console.error('usage: node scripts/crm-import-archive.js <source-crm.db> [--write]'); process.exit(2); }

  const srcDb = new DatabaseSync(src, { readOnly: true });
  const tgt = openCrmDb(); // read-write; sets busy_timeout + WAL + synchronous=FULL
  ensureMessagesTable(tgt);

  // 1. Target's sent_at set (dedup) and sent_at -> conv_id (for the conv remap).
  const tgtSentAt = new Set();
  const tgtConvBySentAt = new Map();
  for (const r of tgt.prepare('SELECT sent_at, conv_id FROM messages').all()) {
    tgtSentAt.add(r.sent_at);
    if (r.conv_id != null && !tgtConvBySentAt.has(r.sent_at)) tgtConvBySentAt.set(r.sent_at, r.conv_id);
  }

  // 2. Build the source->target conv_id remap by majority vote over shared sent_ats.
  const srcRows = srcDb.prepare(
    'SELECT id, conv_id, conversation, contact_slug, sent_at, sender, body, src, type, att_hashes FROM messages ORDER BY sent_at, id',
  ).all();
  const votes = new Map(); // srcConv -> Map(tgtConv -> count)
  for (const r of srcRows) {
    if (r.conv_id == null) continue;
    const tgtConv = tgtConvBySentAt.get(r.sent_at);
    if (tgtConv == null) continue;
    if (!votes.has(r.conv_id)) votes.set(r.conv_id, new Map());
    const m = votes.get(r.conv_id);
    m.set(tgtConv, (m.get(tgtConv) || 0) + 1);
  }
  const convMap = new Map();
  for (const [srcConv, m] of votes) {
    let best = null; let bestN = -1;
    for (const [tc, n] of m) if (n > bestN) { best = tc; bestN = n; }
    convMap.set(srcConv, best);
  }

  // 3. The rows to import: source rows whose sent_at is absent from the target.
  const missing = srcRows.filter((r) => !tgtSentAt.has(r.sent_at));
  const byType = {};
  let unmappedConv = 0;
  for (const r of missing) {
    byType[r.type || '(null)'] = (byType[r.type || '(null)'] || 0) + 1;
    if (r.conv_id != null && !convMap.has(r.conv_id)) unmappedConv += 1;
  }
  const maxId = tgt.prepare('SELECT COALESCE(MAX(id), 0) hi FROM messages').get().hi;

  console.log(`source: ${path.resolve(src)}  (${srcRows.length} rows)`);
  console.log(`target: ${CRM_DB}`);
  console.log(`conv_id remaps resolved: ${convMap.size}`);
  console.log(`to import (sent_at absent from target): ${missing.length}`);
  console.log(`  by type: ${JSON.stringify(byType)}`);
  console.log(`  rows whose conv_id could not be remapped (import as NULL conv_id): ${unmappedConv}`);
  console.log(`fresh ids will start at ${maxId + 1}`);

  if (!missing.length) { console.log('\nnothing to import — target already contains every source message.'); srcDb.close(); tgt.close(); return; }
  if (!write) { console.log('\nDRY RUN — re-run with --write to apply.'); srcDb.close(); tgt.close(); return; }

  const lock = require('../lib/pipeline-lock').acquire('import');
  if (!lock.ok) { console.error(`another pipeline run is active (${lock.holderDesc}) — try again later.`); srcDb.close(); tgt.close(); process.exit(1); }

  let id = maxId;
  let inserted = 0;
  const ins = tgt.prepare(
    'INSERT INTO messages (id, conv_id, conversation, contact_slug, sent_at, sender, body, src, type, att_hashes) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  try {
    tgt.exec('BEGIN IMMEDIATE');
    for (const r of missing) {
      id += 1;
      const conv = r.conv_id != null ? (convMap.get(r.conv_id) ?? null) : null;
      ins.run(id, conv, r.conversation ?? null, r.contact_slug ?? null, r.sent_at, r.sender, r.body, r.src ?? null, r.type ?? null, r.att_hashes ?? null);
      inserted += 1;
    }
    tgt.exec('COMMIT');
  } catch (e) {
    try { tgt.exec('ROLLBACK'); } catch { /* already rolled back */ }
    lock.release(); srcDb.close(); tgt.close();
    console.error(`\nFAILED — rolled back, target unchanged: ${e.message}`);
    process.exit(1);
  }
  lock.release();
  srcDb.close();
  tgt.close();
  console.log(`\nimported ${inserted} message(s); target ids ${maxId + 1}..${id}. These are unmerged, so the next ingest folds them into their contacts' profiles.`);
}

if (require.main === module) main();
module.exports = { main };
