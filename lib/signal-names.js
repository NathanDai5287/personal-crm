'use strict';
// lib/signal-names.js — THE one place a person's display name is decided.
//
// THE RULE (Nathan's, 2026-09-03). The nickname you set in the Signal app is the
// source of truth. It lives in Signal's own database (nicknameGivenName /
// nicknameFamilyName on the conversation) and syncs through Signal's encrypted
// storage service to every linked device — verified by reading the same 19
// nicknames, byte-identical, out of Signal on DUNA and on MINMUS. So setting a
// nickname on your laptop renames that person everywhere, including here.
//
// PRIORITY:
//   1. Signal nickname        — what YOU decided to call them, synced across devices
//   2. Signal contact name    — your iPhone Contacts entry, synced from the phone
//   3. Phone number (e164)    — no name anywhere; a number beats a wrong name
//   4. serviceId prefix       — last resort, so a person always has SOME handle
//
// DELIBERATELY IGNORED: the Signal PROFILE name. That one is set by THEM, not you,
// which is how the CRM ended up calling Darren "fingersix" and Abhiram "A Ch" in
// every ledger the model read. It is never consulted, at any priority.
//
// This replaced the old `COALESCE(name, profileFullName, profileName, e164)` that
// each caller wrote out by hand, and the crm-display-names.json override file that
// existed only to paper over its wrong answers.

// Pull both name fields out of a conversation row. `json` carries the fields
// Signal Desktop does not promote to columns; the `name` column mirrors the system
// contact name and is kept as a fallback for older rows whose json lacks it.
function namesFromRow(row) {
  let j = {};
  try { j = JSON.parse(row.json || '{}') || {}; } catch { /* unparseable json: columns only */ }
  const join = (a, b) => [a, b].filter(Boolean).join(' ').trim() || null;
  return {
    nickname: join(j.nicknameGivenName, j.nicknameFamilyName),
    contact: join(j.systemGivenName, j.systemFamilyName) || row.name || null,
    e164: row.e164 || null,
  };
}

// The resolved name for one conversation row, plus WHICH source won — callers that
// report to a human (crm-autopromote) say where a name came from.
function nameFor(row) {
  const n = namesFromRow(row);
  if (n.nickname) return { name: n.nickname, source: 'signal nickname' };
  if (n.contact) return { name: n.contact, source: 'iPhone contact' };
  if (n.e164) return { name: n.e164, source: 'phone number' };
  const sid = row.serviceId || '';
  return { name: sid ? sid.slice(0, 8) : 'unknown', source: 'serviceId' };
}

const SELECT = `SELECT id, serviceId, name, e164, json FROM conversations
                WHERE type = 'private' AND serviceId IS NOT NULL`;

// Nathan and the old bot are never "a contact to title": both are special-cased to
// fixed labels everywhere (Nathan / Janet), and a tracked contact row that points at
// one of these serviceIds is a data error, not a person to rename. Excluding them
// here means a mis-linked contact keeps its existing heading instead of being
// silently retitled to the bot's Signal nickname.
const { MY_SERVICE_ID, BOT_SERVICE_ID } = require('./config');
const SKIP = new Set([MY_SERVICE_ID, BOT_SERVICE_ID]);

// serviceId -> resolved name, for every 1:1 conversation. The map every caller that
// labels message senders builds once per run.
function signalNameMap(sdb) {
  const m = new Map();
  for (const row of sdb.prepare(SELECT).all()) {
    if (SKIP.has(row.serviceId)) continue;
    m.set(row.serviceId, nameFor(row).name);
  }
  return m;
}

// serviceId -> { name, source, ...raw }, when a caller needs the provenance too.
function signalNameDetails(sdb) {
  const m = new Map();
  for (const row of sdb.prepare(SELECT).all()) {
    if (SKIP.has(row.serviceId)) continue;
    m.set(row.serviceId, { ...nameFor(row), ...namesFromRow(row), convId: row.id });
  }
  return m;
}

module.exports = { signalNameMap, signalNameDetails, nameFor, namesFromRow };
