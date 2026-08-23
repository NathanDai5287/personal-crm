// Build a properly ATTRIBUTED transcript for any Signal conversation (group or DM)
// from Nathan's Signal Desktop DB, which records who sent each message.
// Usage:
//   node crm-transcript.js "<conversation name substring>" [limit=20]
//   node crm-transcript.js "Nat & Kat" 20
//   node crm-transcript.js --service <serviceId/uuid> [limit]   # DM, selects private conversation by serviceId
//   node crm-transcript.js --conv <conversationId|groupId> [limit] # group/DM, selects by conversations.id or groupId
//   (--service / --conv take precedence over the name substring; name remains the fallback.)
const { openSignalDb } = require('../lib/signal-db');
const { BOT_SERVICE_ID } = require('../lib/config');

// Parse args: support `--service <id>` / `--conv <id>` flags alongside the
// legacy positional `<name substring> [limit]`. Anything not consumed by a flag
// is treated as a positional, so the original CLI shape keeps working unchanged.
function parseArgs(argv) {
  const out = { service: undefined, conv: undefined, positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--service' || a === '--conv') {
      const val = argv[i + 1];
      if (val === undefined) {
        console.error(`missing value for ${a}`);
        process.exit(1);
      }
      if (a === '--service') out.service = val.trim();
      else out.conv = val.trim();
      i++; // skip the consumed value
      continue;
    }
    if (a.startsWith('--service=')) { out.service = a.slice('--service='.length).trim(); continue; }
    if (a.startsWith('--conv=')) { out.conv = a.slice('--conv='.length).trim(); continue; }
    out.positionals.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
// A serviceId may arrive prefixed as `uuid:<raw>` (Signal SenderId form); strip it.
const serviceId = args.service ? args.service.replace(/^uuid:/i, '').trim() : undefined;
// A conv selector may arrive prefixed as `group:<id>` (Signal From/To form); strip it.
const convSelector = args.conv ? args.conv.replace(/^group:/i, '').trim() : undefined;
// Selector flags consume their target, so a remaining lone numeric positional is
// the limit. Without flags, positionals stay `[name, limit]` exactly as before.
const usingSelectorFlag = Boolean(serviceId || convSelector);
const nameQuery = usingSelectorFlag ? undefined : args.positionals[0];
const limitArg = usingSelectorFlag ? args.positionals[0] : args.positionals[1];
const limit = parseInt(limitArg || '20', 10);

// Pacific "YYYY-MM-DD HH:MM", matching every ledger/Timeline stamp (was UTC).
const { fmtLocal } = require('../lib/weeks');
function fmtTs(ms) { return fmtLocal(ms); }

const db = openSignalDb();

// serviceId -> display name, from every private conversation (one row per person).
const nameMap = new Map();
for (const r of db.prepare(`SELECT serviceId, COALESCE(name, profileFullName, profileName, e164) AS nm FROM conversations WHERE type='private' AND serviceId IS NOT NULL`).all()) {
  if (r.nm) nameMap.set(r.serviceId, r.nm);
}

let conv;
if (serviceId) {
  // Resolve the DM (private) conversation by the peer's Signal serviceId/uuid.
  conv = db.prepare(`SELECT id, name, type FROM conversations WHERE serviceId = ? AND type='private' LIMIT 1`).get([serviceId]);
  if (!conv) { console.error(`no private conversation with serviceId "${serviceId}"`); process.exit(1); }
} else if (convSelector) {
  // Resolve by Signal conversation id (conversations.id) or by group id (conversations.groupId).
  conv = db.prepare(`SELECT id, name, type FROM conversations WHERE id = ? OR groupId = ? ORDER BY type='group' DESC LIMIT 1`).get([convSelector, convSelector]);
  if (!conv) { console.error(`no conversation with id/groupId "${convSelector}"`); process.exit(1); }
} else if (nameQuery) {
  conv = db.prepare(`SELECT id, name, type FROM conversations WHERE name LIKE ? ORDER BY type='group' DESC LIMIT 1`).get([`%${nameQuery}%`]);
  if (!conv) { console.error(`no conversation matching "${nameQuery}"`); process.exit(1); }
} else {
  // Default: the most-recently-active group (the one a just-arrived group message belongs to).
  conv = db.prepare(`
    SELECT c.id, c.name, c.type FROM conversations c
    JOIN messages m ON m.conversationId = c.id
    WHERE c.type = 'group' AND m.body IS NOT NULL
    GROUP BY c.id ORDER BY MAX(m.sent_at) DESC LIMIT 1`).get();
  if (!conv) { console.error('no group conversations found'); process.exit(1); }
}

// Last N text messages, then chronological.
const rows = db.prepare(`
  SELECT body, sent_at, type, sourceServiceId FROM messages
  WHERE conversationId = ? AND body IS NOT NULL AND type IN ('incoming','outgoing')
  ORDER BY sent_at DESC LIMIT ?`).all([conv.id, limit]);
rows.reverse();
db.close();

function sender(m) {
  if (m.type === 'outgoing') return 'Nathan';
  if (m.sourceServiceId === BOT_SERVICE_ID) return 'Janet (me)';
  return nameMap.get(m.sourceServiceId) || `Unknown(${(m.sourceServiceId || '?').slice(0, 8)})`;
}

console.log(`# ${conv.type === 'group' ? 'Group' : 'DM'}: ${conv.name} — last ${rows.length} messages\n`);
for (const m of rows) {
  console.log(`[${fmtTs(m.sent_at)}] ${sender(m)}: ${(m.body || '').replace(/\s+/g, ' ').trim()}`);
}
