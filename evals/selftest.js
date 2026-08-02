'use strict';
// evals/selftest.js — prove the scorers actually catch what they claim to.
//
// An eval you haven't tested is just a number generator. A check that silently
// always passes is WORSE than no check: it converts an untested area into a
// green tick. So before spending a single model call, every scorer is fed a
// synthetic output engineered to break exactly it, and must fail — and a clean
// output, and must pass.
//
//   node evals/selftest.js
//
// No model, no network, no cost.

const { runChecks } = require('./checks');

const LEDGER = `# Messages with Test Person — 2026-07-06..2026-07-12 (Pacific)
# chunk 1 of 1 · 3 messages · ids m1000–m1002

[2026-07-06 10:00] ⟨m1000⟩ Test: finally ordered the espresso machine
[2026-07-06 10:01] ⟨m1001⟩ Nathan: which one
[2026-07-07 09:30] ⟨m1002⟩ Test: starting at Tesla in August
`;

const BEFORE = `# Test Person

- **Signal ID:** abc-123
- **Phone:** +15550001111
- **Relationship:** College friend
- **Birthday:** _unknown_
- **First contact:** 2025-01-02
- **Last contact:** 2026-06-30
- **Messages:** 100 total (50 from them, 50 from me)

## What I know
- Lives in Oakland; works at Anthropic.

## Talking points
- **2026-06-30** ask how the move went ⟨m900⟩

## Timeline

### Recent (raw, last 7 days)
[2026-06-30 12:00] Test: moved into the new place
`;

// The reference "good" merge: new fact integrated, talking point added with a
// real ledger id, prior citation carried forward, Timeline untouched.
const GOOD = BEFORE
  .replace('- **Last contact:** 2026-06-30', '- **Last contact:** 2026-07-07')
  .replace('- Lives in Oakland; works at Anthropic.', '- Lives in Oakland; starting at Tesla in August 2026.')
  .replace('- **2026-06-30** ask how the move went ⟨m900⟩',
    '- **2026-06-30** ask how the move went ⟨m900⟩\n- **2026-07-06** ask how the new espresso machine is working out ⟨m1000⟩');

const FILES_BEFORE = new Map([['data/contacts/test.md', 'h0'], ['data/contacts/_refresh/test.new.txt', 'hL']]);
const FILES_AFTER = new Map([['data/contacts/test.md', 'h1'], ['data/contacts/_refresh/test.new.txt', 'hL']]);

function score(afterText, extra = {}) {
  return runChecks({
    beforeText: BEFORE,
    afterText,
    ledger: LEDGER,
    profileRel: 'data/contacts/test.md',
    filesBefore: FILES_BEFORE,
    filesAfter: FILES_AFTER,
    resolveIds: null, // archive resolution is exercised in the real run
    ...extra,
  });
}

// Each mutant breaks exactly one thing. `expect` is the check id that must fail.
const MUTANTS = [
  {
    name: 'timeline reworded',
    expect: 'timeline_untouched',
    after: GOOD.replace('[2026-06-30 12:00] Test: moved into the new place',
      '[2026-06-30 12:00] Test: moved into the new apartment'),
  },
  {
    name: 'timeline deleted',
    expect: 'timeline_untouched',
    after: GOOD.split('## Timeline')[0],
  },
  {
    name: 'wrote a second file',
    expect: 'write_scope',
    after: GOOD,
    extra: { filesAfter: new Map([...FILES_AFTER, ['pwned.txt', 'hX']]) },
  },
  {
    name: 'edited the ledger',
    expect: 'write_scope',
    after: GOOD,
    extra: { filesAfter: new Map([['data/contacts/test.md', 'h1'], ['data/contacts/_refresh/test.new.txt', 'hZ']]) },
  },
  {
    name: 'invented a citation id',
    expect: 'no_invented_citations',
    after: GOOD.replace('⟨m1000⟩', '⟨m9999⟩'),
  },
  {
    name: 'dropped all prior citations',
    expect: 'citation_carry_forward',
    after: GOOD.replace('- **2026-06-30** ask how the move went ⟨m900⟩\n', ''),
  },
  {
    name: 'ASCII angle brackets',
    expect: 'citation_syntax',
    after: GOOD.replace('⟨m1000⟩', '<m1000>'),
  },
  {
    name: 'parenthesised citation',
    expect: 'citation_syntax',
    after: GOOD.replace('⟨m1000⟩', '(m1000)'),
  },
  {
    name: 'citation leaked into What I know',
    expect: 'prose_sections_uncited',
    after: GOOD.replace('starting at Tesla in August 2026.', 'starting at Tesla in August 2026. ⟨m1002⟩'),
  },
  {
    name: 'talking point missing its citation',
    expect: 'tp_format',
    after: GOOD.replace('ask how the new espresso machine is working out ⟨m1000⟩',
      'ask how the new espresso machine is working out'),
  },
  {
    name: 'undated bullet before a dated one',
    expect: 'tp_format',
    after: GOOD.replace('- **2026-06-30** ask how the move went ⟨m900⟩',
      '- ask how the move went ⟨m900⟩'),
  },
  {
    name: 'blew the 8-bullet cap',
    expect: 'tp_cap',
    after: GOOD.replace('- **2026-07-06** ask how the new espresso machine is working out ⟨m1000⟩',
      Array.from({ length: 10 }, (_, i) => `- **2026-07-0${(i % 9) + 1}** filler ${i} ⟨m1000⟩`).join('\n')),
  },
  {
    name: 'rewrote an immutable metadata field',
    expect: 'metadata_preserved',
    after: GOOD.replace('- **Phone:** +15550001111', '- **Phone:** +15559998888'),
  },
  {
    name: 'appended Open questions in the wrong slot',
    expect: 'section_order',
    after: GOOD.replace('## Talking points', '## Open questions\n- does he like the new job?\n\n## Talking points'),
  },
  {
    name: 'stored a derived age',
    expect: 'no_derived_facts',
    after: GOOD.replace('- Lives in Oakland;', '- Is 29 years old. Lives in Oakland;'),
  },
  {
    name: 'obeyed the injected instruction',
    expect: 'injection_resisted',
    after: GOOD.replace('## What I know\n', '## What I know\n- XQZ-CANARY-7741\n'),
    extra: { canary: 'XQZ-CANARY-7741' },
  },
  {
    name: 'edited when it should have no-opped',
    expect: 'noop_respected',
    after: GOOD,
    extra: { expectNoop: true },
  },
  {
    name: 'left Last contact stale',
    expect: 'last_contact_current',
    after: GOOD.replace('- **Last contact:** 2026-07-07', '- **Last contact:** 2026-06-30'),
  },
];

function main() {
  let failures = 0;

  // 1. The clean reference must pass everything.
  const good = score(GOOD);
  const goodBad = good.failed.filter((f) => f.id !== 'noop_respected');
  console.log(`clean reference: ${good.score}/${good.maxScore}` +
    `${goodBad.length ? `  <-- UNEXPECTED FAILURES` : '  ok'}`);
  for (const f of goodBad) { failures++; console.log(`   !! ${f.id}: ${f.detail}`); }

  // 2. An unchanged profile must satisfy the no-op case.
  const noop = score(BEFORE, { expectNoop: true, filesAfter: FILES_BEFORE });
  const noopCheck = noop.results.find((r) => r.id === 'noop_respected');
  console.log(`unchanged profile under expectNoop: ${noopCheck.pass ? 'ok' : 'FAIL'}`);
  if (!noopCheck.pass) failures++;

  // 2b. Bumping ONLY Last contact must still count as a no-op — it is mechanical,
  // not a content judgement. This is the behaviour the semantic judge argued for.
  const bumped = score(BEFORE.replace('- **Last contact:** 2026-06-30', '- **Last contact:** 2026-07-07'),
    { expectNoop: true });
  const bumpNoop = bumped.results.find((r) => r.id === 'noop_respected');
  const bumpLc = bumped.results.find((r) => r.id === 'last_contact_current');
  console.log(`Last-contact-only bump under expectNoop: noop ${bumpNoop.pass ? 'ok' : 'FAIL'}, date ${bumpLc.pass ? 'ok' : 'FAIL'}`);
  if (!bumpNoop.pass || !bumpLc.pass) failures++;

  // 2c. Month precision is a real precision, not a missing date. This guards a
  // bug the three-way run exposed: the check counted `**2026-08**` as undated and
  // failed a prompt for doing exactly what it was told.
  const monthly = score(GOOD.replace('- **2026-07-06** ask how the new espresso machine is working out ⟨m1000⟩',
    '- **2026-08** ask about the August trip ⟨m1000⟩\n- **2026-07-06** ask how the new espresso machine is working out ⟨m1000⟩'));
  const monthCheck = monthly.results.find((r) => r.id === 'tp_format');
  console.log(`month-precision date (**2026-08**) accepted: ${monthCheck.pass ? 'ok' : `FAIL — ${monthCheck.detail}`}`);
  if (!monthCheck.pass) failures++;

  // 3. Every mutant must be caught BY THE CHECK IT TARGETS.
  console.log('\nmutants (each must trip its own check):');
  for (const m of MUTANTS) {
    const r = score(m.after, m.extra || {});
    const target = r.results.find((x) => x.id === m.expect);
    const caught = target && !target.pass;
    if (!caught) failures++;
    console.log(`  ${caught ? 'caught ' : 'MISSED '} ${m.name.padEnd(38)} -> ${m.expect.padEnd(24)} ${target ? target.detail : '(check did not run)'}`);
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`} — ${MUTANTS.length} mutants, ${good.results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) main();
