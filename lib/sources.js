'use strict';
// lib/sources.js — shared "which conversations count as talking to this
// person" logic, used by BOTH crm-refresh.js (ledgers) and crm-compact.js
// (timelines) so the two stay in agreement about what a contact's message
// universe is:
//   dmConvIds         private 1:1 conversations -> ALL messages
//   biGroupConvIds    groups where the contact is the ONLY other party besides
//                     me and the old bot (e.g. "Nat & Kat") -> both directions
//   multiGroupConvIds larger groups they're in -> only their own messages
//   labels            convId -> group display name
const { MY_SERVICE_ID, BOT_SERVICE_ID } = require('./config');

function resolveSources(sdb, contactServiceId) {
  const dm = sdb
    .prepare("SELECT id, name FROM conversations WHERE serviceId = ? AND type = 'private' LIMIT 1")
    .get([contactServiceId]);
  const dmConvIds = dm ? [dm.id] : [];
  const biGroupConvIds = [];
  const multiGroupConvIds = [];
  const labels = {};

  const groups = sdb.prepare("SELECT id, name, members FROM conversations WHERE type = 'group'").all();
  for (const g of groups) {
    const members = (g.members || '').split(/\s+/).filter(Boolean);
    if (!members.includes(contactServiceId)) continue;
    labels[g.id] = g.name || 'group';
    const others = members.filter((m) => m !== MY_SERVICE_ID && m !== BOT_SERVICE_ID);
    if (others.length === 1 && others[0] === contactServiceId) {
      biGroupConvIds.push(g.id); // effectively a private channel with the contact
    } else {
      multiGroupConvIds.push(g.id); // shared group: only the contact's own messages
    }
  }
  return { dmConvIds, biGroupConvIds, multiGroupConvIds, labels };
}

// Is this group conversation a "bi-group" (only other party besides me/bot is
// a single person)? Used by compaction to avoid double-covering bi-groups via
// both a contact's own timeline AND group-activity folding.
function groupOthers(membersStr) {
  return (membersStr || '').split(/\s+/).filter(Boolean).filter((m) => m !== MY_SERVICE_ID && m !== BOT_SERVICE_ID);
}

// Build the Signal-DB message query (SELECT + params) for one contact across
// all their sources. `bound` is the incremental bound: {clause, param} —
// either rowid>cursor or sent_at>=since. Returns null if the contact has no
// sources at all. Shared by crm-refresh.js (ledgers) and crm-web.js (live
// unmerged counts on the status board) so both agree on what "pending
// messages" means. NULL-src note: outgoing messages often carry a NULL
// sourceServiceId, so bi-group "both directions" matches type='outgoing' too.
function buildMessageQuery(sources, contactServiceId, bound) {
  const { dmConvIds, biGroupConvIds, multiGroupConvIds } = sources;
  const clauses = [];
  const params = [];
  const inList = (ids) => ids.map(() => '?').join(',');

  if (dmConvIds.length) {
    clauses.push(`(conversationId IN (${inList(dmConvIds)}))`);
    params.push(...dmConvIds);
  }
  if (biGroupConvIds.length) {
    clauses.push(`(conversationId IN (${inList(biGroupConvIds)}) AND (type = 'outgoing' OR sourceServiceId IN (?, ?)))`);
    params.push(...biGroupConvIds, MY_SERVICE_ID, contactServiceId);
  }
  if (multiGroupConvIds.length) {
    clauses.push(`(conversationId IN (${inList(multiGroupConvIds)}) AND sourceServiceId = ?)`);
    params.push(...multiGroupConvIds, contactServiceId);
  }
  if (clauses.length === 0) return null;

  const sql = `
    SELECT rowid AS rid, body, sent_at, type, conversationId AS cid, sourceServiceId AS src
    FROM messages
    WHERE body IS NOT NULL AND type IN ('incoming','outgoing')
      AND ${bound.clause}
      AND (${clauses.join(' OR ')})
    ORDER BY rowid ASC`;
  return { sql, params: [bound.param, ...params] };
}

module.exports = { resolveSources, groupOthers, buildMessageQuery };
