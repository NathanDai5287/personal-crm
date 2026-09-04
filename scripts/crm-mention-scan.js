// scripts/crm-mention-scan.js — the deterministic name scan that builds the
// `mentions` relationship graph (lib/schema.js). A textual mention of a tracked
// person BY a resolvable speaker is one directed edge speaker -> target, one row per
// (speaker, target, message); Nathan gets a node too ('nathan') when he is the
// speaker or the resolver names him as a target. A message whose speaker can't be
// attributed to a tracked person (an untracked group speaker) yields no edge.
//
// FULL REBUILD every run: cheap (~6s over ~100k messages) and always correct
// after a new nickname or contact is added, so there is no incremental state
// to keep consistent. `source='scan'` rows are ours and are deleted-then-
// reinserted wholesale each run; `source='model'` rows (the retired merge
// side-channel) are never touched, so the DELETE is scoped to `source='scan'`
// only. Human corrections live in mention_reassign (lib/schema.reassignMap)
// and are applied AS we insert, so a hand-fixed citation survives every
// rebuild instead of being clobbered by the next one.
'use strict';
const { ensureMessagesTable } = require('../lib/archive');
const { recordMention, reassignMap, mentionSchema } = require('../lib/schema');
const { buildResolver } = require('../lib/people-resolve');
const { MY_SERVICE_ID, BOT_SERVICE_ID } = require('../lib/config');
const { ownWords } = require('../lib/task-trigger');
const { trackedContacts } = require('../lib/person');

// cdb: the crm.db handle. opts.resolver lets callers (the selftest) inject a
// fixture resolver instead of building one from the real contacts table.
function rebuildMentions(cdb, opts = {}) {
  ensureMessagesTable(cdb);
  mentionSchema(cdb);

  // TRACKED people only (lib/person.trackedContacts): a contacts row with a profile on
  // disk. An untracked stub therefore can't become a graph node, a mention target, or a
  // speaker. Only queried for the halves the caller didn't inject (the selftest injects
  // both and has no contacts table).
  const contacts = (opts.resolver && opts.idToSlug) ? [] : trackedContacts(cdb);
  const resolver = opts.resolver || buildResolver(
    contacts.map((c) => ({ slug: c.slug, name: c.name })).filter((c) => c.slug)
  );
  // serviceId -> slug for tracked contacts. `src` (the sender's Signal serviceId) is the
  // AUTHORITATIVE speaker of a message; contact_slug is only the contact the row was
  // INGESTED for, so it names the speaker on a genuine 1:1 DM but not a group third party.
  const idToSlug = opts.idToSlug || new Map(
    contacts.filter((c) => c.signalId && c.slug).map((c) => [c.signalId, c.slug])
  );
  // The tracked slugs, for gating the legacy contact_slug fallback below: a row's
  // contact_slug may name an UNtracked person (a pruned stub), and trusting it would
  // mint a speaker edge from someone who isn't tracked — the exact invariant this
  // refactor removes. idToSlug's values are the tracked slugs.
  const trackedSlugs = new Set(idToSlug.values());
  const remap = reassignMap(cdb);

  let scanned = 0;
  let edges = 0;
  let deleted = 0;

  cdb.exec('BEGIN IMMEDIATE');
  try {
    deleted = Number(cdb.prepare("DELETE FROM mentions WHERE source = 'scan'").run().changes || 0);

    const rows = cdb.prepare(
      "SELECT id, body, sender, contact_slug, src, type, conversation, sent_at FROM messages WHERE body IS NOT NULL AND body <> ''"
    ).all();

    for (const row of rows) {
      scanned += 1;

      // Speaker attribution. `type`/`src` are authoritative where present; a group
      // third party carries the ingest contact's slug in contact_slug, so that
      // column names the speaker only on a genuine 1:1 DM, never in a group.
      let speaker;
      if (row.type === 'outgoing' || row.src === MY_SERVICE_ID) speaker = 'nathan';
      else if (row.src === BOT_SERVICE_ID) speaker = null;         // the bot is not tracked
      else if (row.src) speaker = idToSlug.get(row.src) || null;   // exact: who actually spoke
      // Legacy rows archived before src/type existed: fall back to the old heuristic,
      // but trust contact_slug only for a DM ('DM with …'), never a group row.
      else if (/^nathan$/i.test(row.sender)) speaker = 'nathan';
      else if (row.contact_slug && trackedSlugs.has(row.contact_slug) && /^DM with /.test(row.conversation || '')) speaker = row.contact_slug;
      else speaker = resolver.resolve(row.sender);
      if (!speaker) continue; // can't attribute this message to anyone tracked

      // Scan only the person's TYPED words, not the baked enrichments. composeBody
      // leads a reply with [re X: "..."] and a link with [link: ...]; scanning those
      // would mint edges to the quoted author (and to names inside the quoted text)
      // that the speaker never typed. ownWords strips them, same rule the todo
      // trigger uses -- a mention, like a task, must be typed.
      const targets = resolver.mentionsIn(ownWords(row.body || ''));
      for (const target of targets) {
        // Follow the correction chain: a second reassign of the same citation keys
        // its override off the previous corrected target, so chase transitively
        // (guarding against a cycle) to land on the final hand-chosen target.
        let eff = target;
        const seen = new Set();
        while (!seen.has(eff) && remap.has(`${row.id}|${speaker}|${eff}`)) {
          seen.add(eff);
          eff = remap.get(`${row.id}|${speaker}|${eff}`);
        }
        if (eff === speaker) continue; // no self-edges
        const changes = recordMention(cdb, {
          from_slug: speaker,
          to_slug: eff,
          kind: 'mentioned',
          note: null,
          src_msg: row.id,
          observed_at: row.sent_at,
          run_id: null,
          source: 'scan',
        });
        edges += changes;
      }
    }
    cdb.exec('COMMIT');
  } catch (e) {
    cdb.exec('ROLLBACK');
    throw e;
  }

  return { scanned, edges, deleted };
}

function main() {
  const lock = require('../lib/pipeline-lock').acquire('mention-scan');
  if (!lock.ok) {
    console.log('crm-mention-scan: skipped, run in progress (' + lock.holderDesc + ').');
    process.exit(0);
  }
  try {
    const { openCrmDb } = require('../lib/signal-db');
    const cdb = openCrmDb();
    const { edges, scanned, deleted } = rebuildMentions(cdb);
    console.log(`crm-mention-scan: ${edges} edges from ${scanned} messages (cleared ${deleted}).`);
    cdb.close();
  } finally {
    lock.release();
  }
}

if (require.main === module) main();

module.exports = { rebuildMentions };
