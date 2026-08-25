'use strict';
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { ensureMessagesTable } = require('../lib/archive');
const { markMerged } = require('../lib/archive');
const { currentFacts, factHistory, neighbors, deriveAge } = require('../lib/schema');
const { parseStructuredReply, applyStructuredReply, renderStructuredProfile } = require('../lib/structured-person');

function db() {
  const h = new DatabaseSync(':memory:');
  ensureMessagesTable(h);
  const ins = h.prepare('INSERT INTO messages (id, sent_at, sender, body, contact_slug) VALUES (?, ?, ?, ?, ?)');
  ins.run(10, Date.parse('2024-02-01T20:00:00Z'), 'A', 'old employer', 'alice');
  ins.run(20, Date.parse('2026-02-01T20:00:00Z'), 'A', 'new employer', 'alice');
  ins.run(30, Date.parse('2026-03-01T20:00:00Z'), 'A', 'mentions Bob', 'alice');
  return h;
}

function reply(facts, mentions = []) {
  return `DONE — 0 talking points, ${facts.length} facts added/changed\n[[FACTS]]\n${JSON.stringify(facts)}\n[[/FACTS]]\n[[MENTIONS]]\n${JSON.stringify(mentions)}\n[[/MENTIONS]]`;
}

assert.throws(() => parseStructuredReply('DONE', { required: true }), /missing required/);
assert.deepStrictEqual(parseStructuredReply(reply([])).facts, []);
assert.strictEqual(deriveAge('2000-01-01', Date.parse('2026-08-24T12:00:00Z')), 26);

const h = db();
const resolve = (name) => name === 'Bob Smith' ? 'bob-smith' : null;
const newest = { field: 'employer', kind: 'standing', value: 'New Co', source_message_id: 20 };
let r = applyStructuredReply(h, 'alice', reply([newest], [
  { target: 'Bob Smith', kind: 'mentioned', note: 'invited Bob', source_message_id: 30 },
]), { resolve, runId: 'run-1' });
assert.strictEqual(r.factsStored, 1);
assert.strictEqual(currentFacts(h, 'alice')[0].value, 'New Co');
assert.strictEqual(neighbors(h, 'alice').outbound[0].slug, 'bob-smith');

// Exact replay is free: no duplicate fact or mention.
r = applyStructuredReply(h, 'alice', reply([newest], [
  { target: 'Bob Smith', kind: 'mentioned', note: 'invited Bob', source_message_id: 30 },
]), { resolve, runId: 'run-2' });
assert.strictEqual(r.factsStored, 0);
assert.strictEqual(factHistory(h, 'alice', 'employer').length, 1);
assert.strictEqual(neighbors(h, 'alice').outbound[0].n, 1);

// An older backfilled statement is recorded but cannot take the crown.
applyStructuredReply(h, 'alice', reply([
  { field: 'employer', kind: 'standing', value: 'Old Co', source_message_id: 10 },
]), { resolve });
assert.strictEqual(currentFacts(h, 'alice').find((f) => f.field === 'employer').value, 'New Co');
assert.strictEqual(factHistory(h, 'alice', 'employer').length, 2);

// Snapshot dates form a series; a correction at the same as-of replaces only
// that point, while a different as-of coexists.
applyStructuredReply(h, 'alice', reply([
  { field: 'balance', kind: 'snapshot', value: '$10', value_num: 10, as_of: '2026-02-01', source_message_id: 20 },
  { field: 'balance', kind: 'snapshot', value: '$12', value_num: 12, as_of: '2026-03-01', source_message_id: 30 },
]), { resolve });
applyStructuredReply(h, 'alice', reply([
  { field: 'balance', kind: 'snapshot', value: '$11 corrected', value_num: 11, as_of: '2026-02-01', source_message_id: 30 },
]), { resolve });
assert.deepStrictEqual(currentFacts(h, 'alice').filter((f) => f.field === 'balance').map((f) => f.value).sort(), ['$11 corrected', '$12']);

// A bad mention rolls back the fact written in the same reply.
assert.throws(() => applyStructuredReply(h, 'alice', reply([
  { field: 'favorite_color', kind: 'standing', value: 'green', source_message_id: 30 },
], [{ target: 'Ambiguous Max', kind: 'mentioned', source_message_id: 30 }]), { resolve }), /unknown or ambiguous/);
assert.strictEqual(currentFacts(h, 'alice').some((f) => f.field === 'favorite_color'), false);

assert.throws(() => applyStructuredReply(h, 'alice', reply([
  { field: 'age', kind: 'standing', value: '26', source_message_id: 30 },
]), { resolve }), /derived/);
assert.throws(() => applyStructuredReply(h, 'alice', reply([
  { field: 'birthday', kind: 'standing', value: 'January 1', source_message_id: 999 },
]), { resolve }), /missing archive message/);

const md = '# Alice\n- **Relationship:** friend\n\n## What I know\n\n### Work\nOld prose ⟨m10⟩\n\n## Timeline\n\n- 2024: met ⟨m10⟩\n';
const timeline = md.slice(md.indexOf('## Timeline'));
const rendered = renderStructuredProfile(md, currentFacts(h, 'alice'));
assert.strictEqual(rendered.slice(rendered.indexOf('## Timeline')), timeline);
assert.match(rendered, /\*\*Employer:\*\* New Co ⟨m20⟩/);
assert.doesNotMatch(rendered, /Old prose/);

// Facts, mentions, and the merge frontier can share the caller's transaction.
const h2 = db();
h2.exec('BEGIN IMMEDIATE');
applyStructuredReply(h2, 'alice', reply([newest]), { resolve, transaction: false });
markMerged(h2, 'alice', [20], Date.now(), { transaction: false });
h2.exec('ROLLBACK');
assert.strictEqual(currentFacts(h2, 'alice').length, 0);
assert.strictEqual(h2.prepare('SELECT COUNT(*) n FROM merged').get().n, 0);
h2.close();

h.close();
console.log('structured-person selftest: PASS');
