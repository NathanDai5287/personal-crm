'use strict';
// evals/tasks-contam.js — fail if a task prompt quotes a frozen eval fixture.
//
//   node evals/tasks-contam.js          # exit 1 if any gold fixture is quoted
//   node evals/tasks-contam.js --list   # show every cited id and where it lands
//
// WHY THIS EXISTS: a prompt that quotes its own eval fixture is not being measured, it is
// being asked to recall. This has now happened three times in one day, each time caught
// only because someone went looking:
//
//   - merge-v5 embedded worked examples built from arshia and charles, who are also merge
//     fixtures. The eval had to grow a held-out/contaminated split to stay meaningful.
//   - prompts/tasks.md was given a Charles exchange as an example while that same
//     exchange was the SOLE strong candidate in the charles gold file.
//   - after fixing that, an audit found the Caden and Katia examples quoted seven and
//     eight fixture ids respectively — including two of Nathan's six labelled tasks.
//
// Every one of those was a judgement call by a careful reader. This makes it arithmetic.
//
// THE RULE: a prompt may quote CONTAMINATED contacts freely, because they are already
// excluded from gold. It must never quote a gold fixture. Charles is both — contaminated
// below m90515, gold above it — and that is fine, because the fixture only contains the
// upper range, so the id check resolves it automatically without special-casing.

const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/config');
const { LEDGER_DIR, GOLD_DIR } = require('./tasks-fixtures');

const PROMPTS = ['prompts/tasks.md', 'prompts/tasks-v2.md', 'prompts/tasks-v3.md'];

// Ids the prompt cites, in either form it can appear: a ⟨m…⟩ ledger line inside a worked
// example, or a "msg_id" in an expected-output block.
function citedIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(/⟨m(\d+)⟩/g)) ids.add(Number(m[1]));
  for (const m of text.matchAll(/"msg_id"\s*:\s*(\d+)/g)) ids.add(Number(m[1]));
  return ids;
}

function fixtureIds(file) {
  const s = new Set();
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/⟨m(\d+)⟩/g)) s.add(Number(m[1]));
  return s;
}

function tickedIds(file) {
  const s = new Set();
  if (!fs.existsSync(file)) return s;
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/^- \[x\][^\n]*?ids=([\d,]+)/gmi)) {
    for (const id of m[1].split(',')) s.add(Number(id));
  }
  return s;
}

function check({ list = false } = {}) {
  if (!fs.existsSync(LEDGER_DIR)) {
    console.log('no fixtures built yet — nothing to check');
    return 0;
  }
  const fixtures = fs.readdirSync(LEDGER_DIR).filter((f) => f.endsWith('.txt')).map((f) => {
    const slug = f.replace(/\.txt$/, '');
    return { slug, ids: fixtureIds(path.posix.join(LEDGER_DIR, f)), ticked: tickedIds(path.posix.join(GOLD_DIR, `${slug}.md`)) };
  });

  let violations = 0;
  let ticksHit = 0;
  for (const rel of PROMPTS) {
    const file = path.posix.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const cited = citedIds(fs.readFileSync(file, 'utf8'));
    const rows = [];
    for (const fx of fixtures) {
      const overlap = [...cited].filter((id) => fx.ids.has(id)).sort((a, b) => a - b);
      if (!overlap.length) continue;
      const hitTicked = overlap.filter((id) => fx.ticked.has(id));
      violations += overlap.length;
      ticksHit += hitTicked.length;
      rows.push({ slug: fx.slug, overlap, hitTicked });
    }
    if (!rows.length) {
      console.log(`${rel}: clean (${cited.size} ids cited, none in a fixture)`);
      continue;
    }
    console.log(`${rel}: QUOTES FIXTURES`);
    for (const r of rows) {
      console.log(`   ${r.slug}: ${r.overlap.length} id(s) — ${r.overlap.join(' ')}`);
      if (r.hitTicked.length) console.log(`      >>> ${r.hitTicked.length} of these are TICKED GOLD: ${r.hitTicked.join(' ')}`);
    }
  }

  if (list) {
    console.log('\nfixture id ranges:');
    for (const fx of fixtures) {
      const a = [...fx.ids].sort((x, y) => x - y);
      console.log(`  ${fx.slug.padEnd(16)} m${a[0]}–m${a[a.length - 1]}  (${a.length} msgs, ${fx.ticked.size} ticked ids)`);
    }
  }

  if (!violations) { console.log('\nno prompt quotes any frozen fixture.'); return 0; }
  console.log(`\n${violations} quoted fixture id(s), ${ticksHit} of them TICKED GOLD.`);
  // A quoted-but-unticked id still inflates precision — the model can recall that the
  // line is NOT a task — so any overlap fails, not just overlap with ticks.
  console.log('Rewrite the offending examples with invented contacts and ids, or re-cut the');
  console.log('fixture window. A prompt quoting its own fixture measures recall, not skill.');
  return 1;
}

if (require.main === module) process.exit(check({ list: process.argv.includes('--list') }));
module.exports = { check, citedIds };
