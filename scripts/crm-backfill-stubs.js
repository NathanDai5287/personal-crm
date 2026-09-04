// Mechanical CRM backfill: one stub profile + db row per named private contact.
// No model involved. Pulls names/numbers/contact-dates straight from Signal Desktop.
// One-time tool (kept for reference / re-runs against a fresh contacts dir).
const fs = require('fs');
const path = require('path');
const { openSignalDb, openCrmDb } = require('../lib/signal-db');
const { CONTACTS_DIR } = require('../lib/config');
const { dateKey } = require('../lib/weeks');
const { nameFor } = require('../lib/signal-names');

function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'unknown';
}

const db = openSignalDb();

// Private conversations that have at least one text message, with stats. The name
// is resolved in JS by THE rule (lib/signal-names: Signal nickname > iPhone contact
// > profile name > phone), so the SQL selects raw name fields + json.
const rows = db.prepare(`
  SELECT c.serviceId, c.e164, c.name, c.json,
         COUNT(*) AS msg_count, MIN(m.sent_at) AS first_at, MAX(m.sent_at) AS last_at,
         SUM(CASE WHEN m.type='incoming' THEN 1 ELSE 0 END) AS from_them,
         SUM(CASE WHEN m.type='outgoing' THEN 1 ELSE 0 END) AS from_me
  FROM conversations c
  JOIN messages m ON m.conversationId = c.id
  WHERE c.type='private' AND m.body IS NOT NULL AND m.type IN ('incoming','outgoing')
  GROUP BY c.id
  ORDER BY msg_count DESC
`).all().map((r) => ({ ...r, ...nameFor(r) }))
  // Only people with an actual name (nickname or iPhone contact) get a stub; a bare
  // phone number or serviceId is not worth a profile.
  .filter((r) => r.source === 'signal nickname' || r.source === 'iPhone contact');
db.close();

fs.mkdirSync(CONTACTS_DIR, { recursive: true });

// Build slug uniqueness map.
const usedSlugs = new Map();
function uniqueSlug(name) {
  let base = slugify(name), s = base, i = 2;
  while (usedSlugs.has(s)) { s = `${base}-${i++}`; }
  usedSlugs.set(s, true);
  return s;
}

let made = 0;
const manifest = [];
const dbRecords = [];
for (const r of rows) {
  const name = r.name;
  const slug = uniqueSlug(name);
  const rel = path.posix.join('data/contacts', `${slug}.md`);
  const filePath = path.join(CONTACTS_DIR, `${slug}.md`);
  // Pacific calendar dates, matching every other date in a profile (was UTC).
  const firstISO = r.first_at ? dateKey(r.first_at) : 'unknown';
  const lastISO = r.last_at ? dateKey(r.last_at) : 'unknown';

  const body = `# ${name}

- **Signal ID:** ${r.serviceId || '(none)'}
- **Phone:** ${r.e164 || '(unknown)'}
- **Relationship:** _TBD_
- **Birthday:** _unknown_
- **First contact:** ${firstISO}
- **Last contact:** ${lastISO}
- **Messages:** ${r.msg_count} total (${r.from_them} from them, ${r.from_me} from me)

## What I know
_Not yet enriched. Run the enrichment pass to distill message history into this section._

## Timeline
`;
  fs.writeFileSync(filePath, body);

  dbRecords.push({
    signal_id: r.serviceId || null, phone: r.e164 || null, name,
    last_contact_at: r.last_at || null, file_path: rel,
  });
  manifest.push({ name, slug, msg_count: r.msg_count });
  made++;
}

// Bulk insert into crm.db directly via node:sqlite (no python subprocess).
const cdb = openCrmDb();
const now = Date.now();
const insert = cdb.prepare(
  'INSERT INTO contacts (signal_id,phone,name,relationship,last_contact_at,file_path,created_at) VALUES (?,?,?,?,?,?,?)'
);
cdb.exec('BEGIN');
try {
  for (const r of dbRecords) {
    insert.run(r.signal_id, r.phone, r.name, null, r.last_contact_at, r.file_path, now);
  }
  cdb.exec('COMMIT');
} catch (e) {
  cdb.exec('ROLLBACK');
  throw e;
}
const count = cdb.prepare('SELECT COUNT(*) c FROM contacts').get().c;
console.log('db rows:', count);
cdb.close();

console.log(`Created ${made} contact stubs in ${CONTACTS_DIR}`);
console.log('Top 15 by volume:');
for (const m of manifest.slice(0, 15)) console.log(`  ${m.msg_count}\t${m.name}\t(${m.slug}.md)`);
