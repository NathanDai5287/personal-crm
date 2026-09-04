'use strict';
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { ensureMessagesTable } = require('../lib/archive');
const { recordReassign } = require('../lib/schema');
const { buildResolver } = require('../lib/people-resolve');
const { rebuildMentions } = require('../scripts/crm-mention-scan');

const h = new DatabaseSync(':memory:');
ensureMessagesTable(h);
const ins = h.prepare('INSERT INTO messages (id, sent_at, sender, body, contact_slug) VALUES (?, ?, ?, ?, ?)');

// id=1: Nathan -> Bob (tier 1 speaker: sender 'Nathan').
ins.run(1, 1000, 'Nathan', 'Bob is coming over', null);
// id=2: Bob -> Nathan (tier 2 speaker: contact_slug 'bob').
ins.run(2, 2000, 'Bob Smith', 'Nathan will be there', 'bob');
// id=3: Carol -> Bob (tier 2 speaker; also the reassign target below).
ins.run(3, 3000, 'Carol Jones', 'Bob is also invited', 'carol');
// id=4: self-mention -- must be skipped (no edge).
ins.run(4, 4000, 'Bob Smith', 'Bob will bring snacks', 'bob');
// id=5: no recognizable name -- no edge.
ins.run(5, 5000, 'Carol Jones', 'See you soon', 'carol');
// id=6: group message, no contact_slug -- legacy speaker via resolver.resolve(sender).
ins.run(6, 6000, 'Bob Smith', 'Carol should come too', null);

// Rows WITH src/type: the authoritative-speaker path. These are the shape the live
// per-contact sweep produces for a group (contact_slug = the INGEST contact, not the
// speaker). The scanner must attribute by src, not contact_slug.
const insFull = h.prepare(
  'INSERT INTO messages (id, sent_at, sender, body, contact_slug, src, type) VALUES (?,?,?,?,?,?,?)'
);
// id=7: Carol speaks in BOB's ingested group context -> must be carol->dave, NOT bob->dave.
insFull.run(7, 7000, 'Carol Jones', 'Dave is late', 'bob', 'carol-sid', 'incoming');
// id=8: Carol names the ingest contact himself -> must create carol->bob, not be dropped
// as a bob->bob self-edge (the reported bug).
insFull.run(8, 8000, 'Carol Jones', 'Bob is here', 'bob', 'carol-sid', 'incoming');
// id=9: outgoing is Nathan regardless of the sender label or contact_slug.
insFull.run(9, 9000, 'Nathan', 'Dave says hi', 'carol', 'nathan-sid', 'outgoing');
// id=10: a reply whose baked enrichment names Carol (the quoted author) and Dave
// (inside the quoted text), but Nathan only TYPED "sounds good" -> no edge. Scanning
// the enrichment would falsely mint nathan->carol and nathan->dave.
insFull.run(10, 10000, 'Nathan', '[re Carol: "Dave is fake"] sounds good', 'carol', 'nathan-sid', 'outgoing');

const resolver = buildResolver([
  { slug: 'bob', name: 'Bob Smith' },
  { slug: 'carol', name: 'Carol Jones' },
  { slug: 'dave', name: 'Dave Kim' },
]);
const idToSlug = new Map([['carol-sid', 'carol'], ['bob-sid', 'bob'], ['dave-sid', 'dave']]);

let r = rebuildMentions(h, { resolver, idToSlug });
assert.strictEqual(r.scanned, 10, 'scanned all 10 candidate messages');
assert.strictEqual(r.deleted, 0, 'nothing to clear on first run');
assert.strictEqual(r.edges, 7, 'the 4 legacy edges + carol->dave, carol->bob, nathan->dave (enriched reply mints none)');

const edge = (from, to, srcMsg) => h.prepare(
  'SELECT * FROM mentions WHERE from_slug = ? AND to_slug = ? AND src_msg = ?'
).get(from, to, srcMsg);

assert.ok(edge('nathan', 'bob', 1), 'expected nathan->bob edge from message 1');
assert.ok(edge('bob', 'nathan', 2), 'expected bob->nathan edge from message 2');
assert.ok(edge('carol', 'bob', 3), 'expected carol->bob edge from message 3');
assert.ok(edge('bob', 'carol', 6), 'expected group-speaker bob->carol edge from message 6');
// The src-authoritative attributions: the speaker is src, not the ingest contact_slug.
assert.ok(edge('carol', 'dave', 7), 'group speaker resolved by src: carol->dave, not bob->dave');
assert.strictEqual(edge('bob', 'dave', 7), undefined, 'the ingest contact is NOT credited as speaker');
assert.ok(edge('carol', 'bob', 8), 'a third party naming the ingest contact makes carol->bob, not a dropped self-edge');
assert.ok(edge('nathan', 'dave', 9), 'outgoing is attributed to nathan regardless of sender/contact_slug');
assert.strictEqual(h.prepare('SELECT COUNT(*) n FROM mentions WHERE src_msg = 10').get().n, 0, 'the enriched reply mints no edge -- only typed words are scanned');

const selfEdges = h.prepare('SELECT COUNT(*) n FROM mentions WHERE from_slug = to_slug').get().n;
assert.strictEqual(selfEdges, 0, 'no self-edges');

const nonScan = h.prepare("SELECT COUNT(*) n FROM mentions WHERE source <> 'scan'").get().n;
assert.strictEqual(nonScan, 0, 'every row this scan wrote is source=scan');

// Idempotent: a second rebuild with no data change clears the prior scan rows
// and reinserts the same edge count.
r = rebuildMentions(h, { resolver, idToSlug });
assert.strictEqual(r.deleted, 7, 'second run clears the 7 rows the first run wrote');
assert.strictEqual(r.edges, 7, 'second run reproduces the same edge count');

// A human correction (mention_reassign) survives the rebuild: message 3 was
// scanned as carol->bob, but the citation is actually about Nathan.
recordReassign(h, { src_msg: 3, from_slug: 'carol', orig_to: 'bob', new_to: 'nathan' });
r = rebuildMentions(h, { resolver, idToSlug });
assert.strictEqual(r.edges, 7, 'edge count unchanged -- one edge retargeted, not added');
assert.strictEqual(edge('carol', 'bob', 3), undefined, 'the original mis-resolved edge no longer exists');
assert.ok(edge('carol', 'nathan', 3), 'the corrected edge exists instead');

// A CHAINED correction: retarget the same citation a second time, keyed off its
// now-current target (nathan), exactly as the edge page's form posts it. The scanner
// must follow the chain (bob -> nathan -> dave), not snap back to the first hop.
recordReassign(h, { src_msg: 3, from_slug: 'carol', orig_to: 'nathan', new_to: 'dave' });
r = rebuildMentions(h, { resolver, idToSlug });
assert.strictEqual(edge('carol', 'nathan', 3), undefined, 'the first-hop correction is superseded');
assert.ok(edge('carol', 'dave', 3), 'the chained correction (bob->nathan->dave) lands on dave');

h.close();
console.log('mention-scan selftest: PASS');
