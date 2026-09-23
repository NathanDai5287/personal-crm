'use strict';
// evals/self-ledger-selftest.js — prove Nathan's own ledger (crm-refresh writeSelfLedger)
// has the shape prompts/self-merge.md documents: lines GROUPED BY CONVERSATION (one
// contiguous block per chat, blocks ordered by their first message, a blank line between
// blocks), every line carrying its `(DM: Name)` / `(<group>)` label, and the header lines
// the prompt lists. Plus: lib/self keeps Note to Self and the old bot's DM out, and the
// email-fact guard drops an email on the self slug. No model, no network, no cost; uses a
// throwaway directory and an in-memory SQLite archive.
//
//   node evals/self-ledger-selftest.js

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { writeSelfLedger } = require('../scripts/crm-refresh');
const { selfConversations, selfStats } = require('../lib/self');
const { MY_SERVICE_ID, BOT_SERVICE_ID } = require('../lib/config');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass += 1; };

// ---- 1) ledger grouping + labels + header ------------------------------------------
{
  const t0 = Date.UTC(2026, 6, 6, 19, 0); // a Monday, mid-day Pacific
  const min = 60_000;
  // Interleaved in time across three conversations: DM Katia, group G, DM Sam.
  const msgs = [
    { rid: 101, cid: 'dmK', sent_at: t0 + 1 * min, sender: 'Katia', rendered: 'finally ordered the espresso machine' },
    { rid: 102, cid: 'grp', sent_at: t0 + 2 * min, sender: 'Katia', rendered: 'who is driving saturday' },
    { rid: 103, cid: 'dmK', sent_at: t0 + 3 * min, sender: 'Nathan', rendered: 'which one did you get' },
    { rid: 104, cid: 'dmS', sent_at: t0 + 4 * min, sender: 'Sam', rendered: 'october trip?' },
    { rid: 105, cid: 'grp', sent_at: t0 + 5 * min, sender: 'Nathan', rendered: 'i can' },
    { rid: 106, cid: 'grp', sent_at: t0 + 6 * min, sender: 'Janet', src: BOT_SERVICE_ID, rendered: 'reminder' },
  ];
  const plan = {
    slug: 'nathan',
    convById: new Map([
      ['dmK', { convId: 'dmK', kind: 'dm', name: 'Katia', label: 'DM: Katia' }],
      ['grp', { convId: 'grp', kind: 'group', name: 'Nat & Kat', label: 'Nat & Kat' }],
      ['dmS', { convId: 'dmS', kind: 'dm', name: 'Sam', label: 'DM: Sam' }],
    ]),
  };
  const chunk = {
    msgs, count: msgs.length, label: '2026-07-06', ridStart: 101, ridEnd: 106,
    startMs: t0 - 15 * 3600_000, endMs: t0 + 7 * 86_400_000, partial: false,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-ledger-'));
  try {
    // cdb/sdb null: the cast header is best-effort and simply omitted.
    const { file } = writeSelfLedger(null, null, plan, chunk, 1, 2, dir);
    ok(path.basename(file) === 'nathan.new.txt', 'ledger lands at _refresh/nathan.new.txt');
    const text = fs.readFileSync(file, 'utf8');
    const [header, ...rest] = text.split('\n\n');
    const blocks = rest.join('\n\n').trim().split('\n\n');
    ok(/^# Nathan's own conversations — 2026-07-06 \(Pacific\)$/m.test(header), 'header: title line');
    ok(/^# chunk 1 of 2 · 6 messages · ids m101–m106$/m.test(header), 'header: chunk line');
    ok(/^# window: /m.test(header), 'header: window line');
    ok(/^# sources: DM with Katia, group "Nat & Kat", DM with Sam$/m.test(header), 'header: sources in block order');
    ok(blocks.length === 3, `three conversation blocks (got ${blocks.length})`);
    const ids = (b) => [...b.matchAll(/⟨m(\d+)⟩/g)].map((m) => Number(m[1]));
    ok(JSON.stringify(ids(blocks[0])) === '[101,103]', 'block 1 = DM Katia, time order');
    ok(JSON.stringify(ids(blocks[1])) === '[102,105,106]', 'block 2 = the group, time order');
    ok(JSON.stringify(ids(blocks[2])) === '[104]', 'block 3 = DM Sam (first message latest)');
    ok(blocks[0].split('\n').every((l) => l.includes('⟩ (DM: Katia) ')), 'every DM line carries (DM: Katia)');
    ok(blocks[1].split('\n').every((l) => l.includes('⟩ (Nat & Kat) ')), 'every group line carries the group label');
    ok(/\(Nat & Kat\) Janet \(bot\):/.test(blocks[1]), 'the old bot is tagged (bot)');
    ok(/\(DM: Katia\) Nathan: which one/.test(blocks[0]), "Nathan's own line keeps its speaker");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 2) selfConversations: every archived conversation, minus Note to Self / bot DM --
{
  const cdb = new DatabaseSync(':memory:');
  cdb.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, conv_id TEXT, conversation TEXT, contact_slug TEXT,
    sent_at INTEGER NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, src TEXT, type TEXT, att_hashes TEXT)`);
  const ins = cdb.prepare('INSERT INTO messages (id, conv_id, conversation, contact_slug, sent_at, sender, body, src, type) VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run(1, 'c-dm', 'DM with Katia Jacoby', 'katia', 1000, 'Katia', 'hi', 'sid-k', 'incoming');
  ins.run(2, 'c-dm', 'DM with Katia Jacoby', 'katia', 2000, 'Nathan', 'yo', null, 'outgoing');
  ins.run(3, 'c-grp', 'Hike crew', 'sam', 3000, 'Sam', 'sat?', 'sid-s', 'incoming');
  ins.run(4, 'c-grp', 'Hike crew', 'sam', 4000, 'Janet', 'bot says', BOT_SERVICE_ID, 'incoming');
  ins.run(5, 'c-nts', 'Note to Self', null, 5000, 'Nathan', 'note', null, 'outgoing');
  ins.run(6, 'c-bot', 'DM with Janet', null, 6000, 'Janet', 'bot dm', BOT_SERVICE_ID, 'incoming');
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE conversations (id TEXT, type TEXT, name TEXT, serviceId TEXT, members TEXT)');
  const c = raw.prepare('INSERT INTO conversations VALUES (?,?,?,?,?)');
  // The Signal DB driver (vendor/sqlcipher) binds an ARRAY of params; node:sqlite wants
  // them spread. Adapt so the code under test runs its real call shape.
  const sdb = { prepare: (sql) => { const st = raw.prepare(sql); return { all: (p = []) => st.all(...[].concat(p)), get: (p = []) => st.get(...[].concat(p)) }; } };
  c.run('c-dm', 'private', null, 'sid-k', null);
  c.run('c-grp', 'group', 'Hike crew', null, 'sid-s');
  c.run('c-nts', 'private', null, MY_SERVICE_ID, null);
  c.run('c-bot', 'private', null, BOT_SERVICE_ID, null);
  // An alias DM: Signal's conversation row carries the old identity ('sid-old', profile
  // name "Big K"), but the archive files it under the tracked contact katia.
  ins.run(7, 'c-old', 'DM with Katia Jacoby', 'katia', 7000, 'Katia', 'old acct', 'sid-old', 'incoming');
  c.run('c-old', 'private', null, 'sid-old', null);
  cdb.exec('CREATE TABLE contacts (name TEXT, signal_id TEXT, file_path TEXT)');
  cdb.prepare('INSERT INTO contacts VALUES (?,?,?)').run('Katia Jacoby', 'sid-k', 'data/contacts/katia.md');
  const convs = selfConversations(cdb, sdb, new Map([['sid-k', 'Katia'], ['sid-old', 'Big K']]));
  ok(JSON.stringify(convs.map((x) => x.convId)) === '["c-dm","c-grp","c-old"]', 'Note to Self and the bot DM are excluded');
  ok(convs[0].label === 'DM: Katia', "DM label is the tracked contact's Signal name");
  ok(convs[2].label === 'DM: Katia', 'an alias DM is labelled with the contact, not the old profile name');
  ok(convs[1].label === 'Hike crew' && convs[1].kind === 'group', 'group label is the group name');
  const noSdb = selfConversations(cdb, null);
  ok(noSdb.find((x) => x.convId === 'c-dm').label === 'DM: Katia Jacoby', 'without Signal, the archive label is the fallback');
  ok(!noSdb.some((x) => x.convId === 'c-nts'), 'without Signal, Note to Self is still excluded by its archive label');
  const st = selfStats(cdb, ['c-dm', 'c-grp']);
  ok(st.fromNathan === 1 && st.fromOthers === 2, `stats exclude the bot (got ${st.fromNathan}/${st.fromOthers})`);
}

// ---- 3) the self profile never stores an email fact ---------------------------------
{
  const { applyStructuredReply } = require('../lib/structured-person');
  const db = new DatabaseSync(':memory:');
  require('../lib/schema').ensureSchema?.(db);
  db.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, conv_id TEXT, sent_at INTEGER, body TEXT, contact_slug TEXT, sender TEXT, src TEXT, type TEXT)');
  db.prepare('INSERT INTO messages (id, sent_at, body) VALUES (?,?,?)').run(900, Date.UTC(2026, 6, 6), 'my email is x@berkeley.edu');
  const reply = 'DONE — 0 talking points, 1 facts added/changed\n[[FACTS]]\n'
    + JSON.stringify([{ field: 'email', kind: 'standing', value: 'x@berkeley.edu', description: 'his email address', source_message_id: 900 }])
    + '\n[[/FACTS]]';
  let r;
  try {
    r = applyStructuredReply(db, 'nathan', reply, { validMessageIds: [900] });
  } catch (e) {
    r = { error: e.message };
  }
  ok(!r.error, `self email reply applies without throwing (${r.error || 'ok'})`);
  ok(r.factsStored === 0, 'no email fact stored for nathan');
}

console.log(`self-ledger-selftest: OK (${pass} assertions)`);
