// crm-autopromote.js — CLI over lib/promote: list promotion candidates, or --write to
// promote them all. The candidate/promote logic lives in lib/promote so the web UI's
// "Suggested to track" panel and Track button share exactly this behavior.
//
// SAFE BY DEFAULT — dry-run (just lists candidates) unless --write.
// Usage:
//   node crm-autopromote.js            # dry-run, list who would be promoted
//   node crm-autopromote.js --write    # actually promote (profile + row + tracked.json)
const { openSignalDb, openCrmDb } = require('../lib/signal-db');
const { listCandidates, promoteOne, WINDOW_DAYS, MIN_MSGS, MIN_INCOMING } = require('../lib/promote');

const WRITE = process.argv.includes('--write');

function main() {
  const cdb = openCrmDb();
  const sdb = openSignalDb();
  const cands = listCandidates(cdb, sdb);
  console.log(`crm-autopromote: ${WRITE ? 'WRITE' : 'DRY-RUN'} | window=${WINDOW_DAYS}d `
    + `threshold=${MIN_MSGS}msgs/${MIN_INCOMING}incoming | ${cands.length} candidate(s)\n`);
  const promoted = [];
  for (const c of cands) {
    const label = c.existingSlug ? 'existing contact' : c.source;
    if (WRITE) {
      const r = promoteOne(cdb, sdb, c.serviceId);
      console.log(`- ${c.name} → ${r.slug || '?'}  (${c.total} msgs, ${c.incoming} from them)  [${label}]`);
      if (r.ok) promoted.push(r.slug);
    } else {
      console.log(`- ${c.name}  (${c.total} msgs, ${c.incoming} from them)  [${label}]`);
    }
  }
  sdb.close();
  cdb.close();
  if (WRITE) console.log(`\npromoted ${promoted.length}; added to crm-tracked.json (run crm-timeline next to tier them).`);
  else console.log('\n(dry-run — re-run with --write to promote these.)');
  return { promoted: promoted.length, promotedSlugs: promoted };
}

main();
