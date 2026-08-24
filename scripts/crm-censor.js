'use strict';
// scripts/crm-censor.js — manage contacts HELD for censor review (lib/censor-hold.js).
//
//   node scripts/crm-censor.js list                                   # who is held, and why
//   node scripts/crm-censor.js show <slug>                            # print the rejected chunk
//   node scripts/crm-censor.js resolve <slug> <word> <replacement...> # add a word rule + release
//   node scripts/crm-censor.js release <slug>                         # release without adding a rule
//
// A contact is held when a model provider rejected their merge chunk on content grounds.
// We do NOT auto-guess a replacement — Nathan picks the wording. `resolve` is the common
// case (mask a whole word, e.g. `resolve charles-wu <slur> "[redacted slur]"`); for a
// substring or regex rule use `node lib/redact.js add-regex …` then `release`. On release
// the contact's cursor is untouched, so the next ingest re-merges them with the new rule.
const fs = require('fs');
const HOLD = require('../lib/censor-hold');
const { addRule } = require('../lib/redact');

function usage(code = 2) {
  console.error('usage:');
  console.error('  node scripts/crm-censor.js list');
  console.error('  node scripts/crm-censor.js show <slug>');
  console.error('  node scripts/crm-censor.js resolve <slug> <word> <replacement...>');
  console.error('  node scripts/crm-censor.js release <slug>');
  process.exit(code);
}

function headerOf(slug) {
  try {
    return fs.readFileSync(HOLD.fileFor(slug), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('# held:') || l.startsWith('# error:'))
      .map((l) => l.replace(/^#\s*/, ''))
      .join('  ·  ');
  } catch { return ''; }
}

const [cmd, slug, ...rest] = process.argv.slice(2);

if (cmd === 'list') {
  const h = HOLD.held();
  if (!h.length) { console.log('no contacts held for censor review'); process.exit(0); }
  console.log(`${h.length} contact(s) held for censor review:`);
  for (const s of h) console.log(`  ${s}${headerOf(s) ? `  (${headerOf(s)})` : ''}`);
} else if (cmd === 'show') {
  if (!slug) usage();
  try { process.stdout.write(fs.readFileSync(HOLD.fileFor(slug), 'utf8')); }
  catch { console.error(`no hold for '${slug}' (see: crm-censor.js list)`); process.exit(1); }
} else if (cmd === 'resolve') {
  if (!slug || rest.length < 2) usage();
  if (!HOLD.isHeld(slug)) { console.error(`no hold for '${slug}' (see: crm-censor.js list)`); process.exit(1); }
  const word = rest[0].toLowerCase();
  const replacement = rest.slice(1).join(' ');
  addRule({ mode: 'word', pattern: word, replacement, note: 'manual censor-review resolution' });
  HOLD.release(slug);
  console.log(`added word rule: ${word} -> ${replacement}`);
  console.log(`released hold on '${slug}' — the next ingest will re-merge them with this rule applied`);
} else if (cmd === 'release') {
  if (!slug) usage();
  if (HOLD.release(slug)) console.log(`released hold on '${slug}' — the next ingest will re-merge them`);
  else { console.error(`no hold for '${slug}'`); process.exit(1); }
} else {
  usage();
}
