'use strict';
// lib/sources.js — shared "which conversations count as talking to this
// person" logic, used by BOTH crm-refresh.js (ledgers) and crm-compact.js
// (timelines) so the two stay in agreement about what a contact's message
// universe is:
//   dmConvIds         private 1:1 conversations -> ALL messages
//   biGroupConvIds    groups where the contact is the ONLY other party besides
//                     me and the old bot (e.g. "Nat & Kat")
//   multiGroupConvIds larger groups they're in
//   labels            convId -> group display name
// Message selection pulls the FULL conversation from every group (all speakers
// except the old bot) so a contact's group lines carry their context; the bi-/
// multi- split is kept only so ledgers/timelines can label the source and so
// compaction avoids double-covering a bi-group.
const fs = require('fs');
const { MY_SERVICE_ID, BOT_SERVICE_ID, ALIASES } = require('./config');

// crm-aliases.json: canonical serviceId -> [older/alternate serviceIds]. Loaded
// once. A person who re-registered Signal has two accounts; listing the old one
// here folds its whole history into the same contact. Absent/empty = no aliases.
let _aliases;
function loadAliases() {
  if (_aliases) return _aliases;
  try { _aliases = JSON.parse(fs.readFileSync(ALIASES, 'utf8')) || {}; } catch { _aliases = {}; }
  return _aliases;
}

function resolveSources(sdb, contactServiceId) {
  // Every identity that is this same person: the canonical one plus any aliases.
  const allIds = [contactServiceId, ...(loadAliases()[contactServiceId] || [])];

  // DMs: union each identity's 1:1 conversation (both directions, ALL messages).
  const dmStmt = sdb.prepare("SELECT id FROM conversations WHERE serviceId = ? AND type = 'private' LIMIT 1");
  const dmConvIds = [];
  for (const sid of allIds) {
    const dm = dmStmt.get([sid]);
    if (dm && !dmConvIds.includes(dm.id)) dmConvIds.push(dm.id);
  }
  const biGroupConvIds = [];
  const multiGroupConvIds = [];
  const labels = {};

  const groups = sdb.prepare("SELECT id, name, members FROM conversations WHERE type = 'group'").all();
  for (const g of groups) {
    const members = (g.members || '').split(/\s+/).filter(Boolean);
    if (!allIds.some((sid) => members.includes(sid))) continue;
    labels[g.id] = g.name || 'group';
    const others = members.filter((m) => m !== MY_SERVICE_ID && m !== BOT_SERVICE_ID);
    if (others.length === 1 && allIds.includes(others[0])) {
      biGroupConvIds.push(g.id); // effectively a private channel with the contact
    } else {
      multiGroupConvIds.push(g.id); // shared group: only the contact's own messages
    }
  }
  // allIds is returned so the query builders filter a group's messages by ANY of
  // this person's identities (src IN allIds), not just the canonical one — else a
  // re-registered contact's own group messages, sent under an alias serviceId,
  // would be silently dropped even though the group is a resolved source.
  return { dmConvIds, biGroupConvIds, multiGroupConvIds, labels, allIds };
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
  const groupConvIds = [...biGroupConvIds, ...multiGroupConvIds];
  const clauses = [];
  const params = [];
  const inList = (ids) => ids.map(() => '?').join(',');

  if (dmConvIds.length) {
    clauses.push(`(conversationId IN (${inList(dmConvIds)}))`);
    params.push(...dmConvIds);
  }
  if (groupConvIds.length) {
    // FULL GROUP CONTEXT: every speaker in the contact's groups, so their lines
    // have the surrounding conversation — minus the old bot. `IS NOT ?` is
    // null-safe, so Nathan's outgoing (NULL sourceServiceId) is kept.
    clauses.push(`(conversationId IN (${inList(groupConvIds)}) AND sourceServiceId IS NOT ?)`);
    params.push(...groupConvIds, BOT_SERVICE_ID);
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
function buildArchiveQuery(sources, contactServiceId, bound, opts = {}) {
  const { dmConvIds, biGroupConvIds, multiGroupConvIds } = sources;
  const groupConvIds = [...biGroupConvIds, ...multiGroupConvIds];
  const clauses = [];
  const params = [];
  const inList = (ids) => ids.map(() => '?').join(',');

  if (dmConvIds.length) {
    clauses.push(`(conv_id IN (${inList(dmConvIds)}))`);
    params.push(...dmConvIds);
  }
  if (groupConvIds.length) {
    // FULL GROUP CONTEXT: every speaker in the contact's groups, minus the old bot,
    // so the contact's lines carry the surrounding conversation. `IS NOT ?` is
    // null-safe (keeps Nathan's NULL-src outgoing). Same rule for bi- & multi-groups.
    clauses.push(`(conv_id IN (${inList(groupConvIds)}) AND src IS NOT ?)`);
    params.push(...groupConvIds, BOT_SERVICE_ID);
  }
  if (clauses.length === 0) return null;

  // `opts.select` lets a caller reuse this exact source predicate for an aggregate
  // (e.g. MAX(sent_at) to reconstruct the gate's age clock) instead of the row set.
  // `opts.orderBy` overrides the row ordering (the planner asks for sent_at so the
  // gate merges chronologically). A select aggregate drops ordering entirely.
  const select = opts.select || 'id AS rid, body, sent_at, type, conv_id AS cid, src, sender';
  const order = opts.select ? '' : `\n    ORDER BY ${opts.orderBy || 'id ASC'}`;
  const sql = `
    SELECT ${select}
    FROM messages
    WHERE ${bound.clause}
      AND (${clauses.join(' OR ')})${order}`;
  return { sql, params: [...boundParams(bound), ...params] };
}

module.exports = { resolveSources, groupOthers, buildMessageQuery, buildArchiveQuery };
