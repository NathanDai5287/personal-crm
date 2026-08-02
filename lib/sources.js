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

// A bound may carry one param ({clause, param}) or several ({clause, params}),
// the latter for compound bounds like "id > ? AND sent_at < ?" — used to clamp a
// scheduled run to the last COMPLETE Monday-04:00 week (see lib/weeks.js).
function boundParams(bound) {
  return Array.isArray(bound.params) ? bound.params : [bound.param];
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

  // `hasAttachments` in the body test is what keeps caption-less photos, videos
  // and voice notes from being dropped on the floor — the archive sweep turns
  // them into a text placeholder (see lib/attachments.js). `mid` is Signal's
  // string message id, needed to join message_attachments.
  const sql = `
    SELECT rowid AS rid, id AS mid, body, sent_at, type, conversationId AS cid,
           sourceServiceId AS src, hasAttachments
    FROM messages
    WHERE (body IS NOT NULL OR hasAttachments = 1) AND type IN ('incoming','outgoing')
      AND ${bound.clause}
      AND (${clauses.join(' OR ')})
    ORDER BY rowid ASC`;
  return { sql, params: [...boundParams(bound), ...params] };
}

// Same source rules as buildMessageQuery, but against crm.db's ARCHIVE table
// (columns: id, conv_id, src, type, sender, body, sent_at). Used by
// crm-refresh.js to build ledgers from the archive, so messages that have
// since disappeared from Signal still reach the merge.
function buildArchiveQuery(sources, contactServiceId, bound) {
  const { dmConvIds, biGroupConvIds, multiGroupConvIds } = sources;
  const clauses = [];
  const params = [];
  const inList = (ids) => ids.map(() => '?').join(',');

  if (dmConvIds.length) {
    clauses.push(`(conv_id IN (${inList(dmConvIds)}))`);
    params.push(...dmConvIds);
  }
  if (biGroupConvIds.length) {
    clauses.push(`(conv_id IN (${inList(biGroupConvIds)}) AND (type = 'outgoing' OR src IN (?, ?)))`);
    params.push(...biGroupConvIds, MY_SERVICE_ID, contactServiceId);
  }
  if (multiGroupConvIds.length) {
    clauses.push(`(conv_id IN (${inList(multiGroupConvIds)}) AND src = ?)`);
    params.push(...multiGroupConvIds, contactServiceId);
  }
  if (clauses.length === 0) return null;

  const sql = `
    SELECT id AS rid, body, sent_at, type, conv_id AS cid, src, sender
    FROM messages
    WHERE ${bound.clause}
      AND (${clauses.join(' OR ')})
    ORDER BY id ASC`;
  return { sql, params: [...boundParams(bound), ...params] };
}

module.exports = { resolveSources, groupOthers, buildMessageQuery, buildArchiveQuery };
