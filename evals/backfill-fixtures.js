'use strict';
// evals/backfill-fixtures.js — reconstruct fixtures/cases.json for a run made
// before run.js persisted them.
//
//   node evals/backfill-fixtures.js <runId|latest>
//
// Fixture building is deterministic (planAll with sweep:false over an archive
// that only grows, plus profiles read off disk), so rebuilding SHOULD reproduce
// exactly what the run was fed. "Should" is not good enough to hang a diff view
// on, so this VERIFIES the rebuild against the ledger copy sitting in each
// sandbox — that file is ground truth, since it is the literal bytes the model
// read. Any case whose rebuilt ledger doesn't match byte-for-byte is written out
// as unverified and the dashboard will refuse to diff it.

const fs = require('fs');
const path = require('path');
const { buildFixtures } = require('./cases');

const SCRATCH = process.env.CRM_EVAL_DIR
  || 'C:/Users/natha/AppData/Local/Temp/claude/C--Users-natha--openclaw/7de048dc-42ba-4c94-b38c-b7fc743ad280/scratchpad/crm-eval';

function main() {
  let id = process.argv[2];
  const runs = fs.readdirSync(SCRATCH).filter((d) => d.startsWith('run-')).sort();
  if (!id || id === 'latest') id = runs[runs.length - 1];
  const dir = path.join(SCRATCH, id);
  if (!fs.existsSync(path.join(dir, 'scored.json'))) {
    console.error(`no scored.json in ${dir}`);
    process.exit(1);
  }
  const scored = JSON.parse(fs.readFileSync(path.join(dir, 'scored.json'), 'utf8'));

  console.log(`rebuilding fixtures for ${id}…`);
  const cases = buildFixtures(path.join(dir, 'fixtures'));

  let bad = 0;
  const verified = [];
  for (const c of cases) {
    // Any variant's sandbox holds the exact ledger that variant was fed.
    const run = scored.find((s) => s.case === c.name);
    if (!run) { console.log(`  ?  ${c.name.padEnd(16)} no scored run — keeping unverified`); verified.push(c); continue; }
    const led = path.join(dir, run.variant, c.name, 'sandbox', 'data', 'contacts', '_refresh', `${c.slug}.new.txt`);
    const prof = path.join(dir, run.variant, c.name, 'sandbox', 'data', 'contacts', `${c.slug}.md`);
    let ok = false;
    try { ok = fs.readFileSync(led, 'utf8') === c.ledger; } catch { ok = false; }
    if (!ok) {
      bad++;
      console.log(`  !! ${c.name.padEnd(16)} ledger MISMATCH — diff view disabled for this case`);
      verified.push({ ...c, unverified: true });
    } else {
      console.log(`  ok ${c.name.padEnd(16)} ledger matches sandbox byte-for-byte`);
      verified.push(c);
    }
    if (!fs.existsSync(prof)) console.log(`     (note: no post-merge profile at ${prof})`);
  }

  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixtures', 'cases.json'), JSON.stringify(verified, null, 2));
  console.log(`\nwrote fixtures/cases.json — ${verified.length} case(s), ${bad} unverified`);
}

if (require.main === module) main();
