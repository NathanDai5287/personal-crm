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

// TWO THREADS AND A DOZEN LINES, deliberately. Citations are thread-scoped ranges
// now (docs/PROVENANCE-SPEC.md §1), and the sandbox validates them against the
// LEDGER — every line carries its id and its thread label, `(the boys 🐗)` for the
// group and nothing for the direct message (§4). So the fixture has to contain a
// DM run long enough to breach the 10-message cap and a second thread adjacent to
// it in id order, or the over-cap and cross-thread rules have nothing to fire on.
const LEDGER = `# Messages with Test Person — 2026-07-06..2026-07-12 (Pacific)
# chunk 1 of 1 · 15 messages · ids m1000–m1014

[2026-07-06 10:00] ⟨m1000⟩ Test: finally ordered the espresso machine
[2026-07-06 10:01] ⟨m1001⟩ Nathan: which one
[2026-07-06 10:02] ⟨m1002⟩ Test: starting at Tesla in August
[2026-07-06 10:03] ⟨m1003⟩ Nathan: congrats, which team
[2026-07-06 10:04] ⟨m1004⟩ Test: powertrain
[2026-07-06 10:05] ⟨m1005⟩ Nathan: nice
[2026-07-06 10:06] ⟨m1006⟩ Test: starts on the 3rd
[2026-07-06 10:07] ⟨m1007⟩ Nathan: relocating?
[2026-07-06 10:08] ⟨m1008⟩ Test: staying in oakland
[2026-07-06 10:09] ⟨m1009⟩ Nathan: how is the commute
[2026-07-06 10:10] ⟨m1010⟩ Test: 40 min each way
[2026-07-06 10:11] ⟨m1011⟩ Nathan: not bad
[2026-07-07 19:00] ⟨m1012⟩ (the boys 🐗) Test: anyone up for shasta
[2026-07-07 19:02] ⟨m1013⟩ (the boys 🐗) Nathan: maybe
[2026-07-07 19:05] ⟨m1014⟩ (the boys 🐗) Test: ill book it
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
  // The Tesla fact comes from ⟨m1002⟩ and now carries it: as of prompts/merge-v6.md
  // `## What I know` is a CITED section. The pre-existing Oakland claim stays
  // uncited — legacy prose is never given a borrowed id.
  .replace('- Lives in Oakland; works at Anthropic.', '- Lives in Oakland; starting at Tesla in August 2026 ⟨m1002⟩.')
  .replace('- **2026-06-30** ask how the move went ⟨m900⟩',
    '- **2026-06-30** ask how the move went ⟨m900⟩\n- **2026-07-06** ask how the new espresso machine is working out ⟨m1000⟩');

// The v11 SECTIONED shape (prompts/merge-v11.md): ### topic sections, a plain
// uncited summary sentence under each heading, cited detail paragraphs, and the
// ` ts` flag riding in a claim's newest citation. This is the clean reference
// for wik_section_shape, for wik_cited's paragraph arm, and for the widened
// citation grammar — if the parser ever drops ` ts`, the mutants built on this
// text stop being seen at all, which is exactly the failure they exist to catch.
const SECTIONED = GOOD.replace(
  '- Lives in Oakland; starting at Tesla in August 2026 ⟨m1002⟩.',
  [
    '### Living',
    '',
    'Lives in Oakland and staying put for the new job.',
    '',
    'Staying in Oakland for the Tesla job, ~40 min commute each way ⟨m1008-m1010 @m1010⟩.',
    '',
    '### Work',
    '',
    'Starting at Tesla in August 2026.',
    '',
    'Starting at Tesla in August 2026, powertrain team, starts on the 3rd ⟨m1002-m1006 @m1002 ts⟩.',
  ].join('\n'),
);

const FILES_BEFORE = new Map([['data/contacts/test.md', 'h0'], ['data/contacts/_refresh/test.new.txt', 'hL']]);
const FILES_AFTER = new Map([['data/contacts/test.md', 'h1'], ['data/contacts/_refresh/test.new.txt', 'hL']]);

// A stand-in for the real archive. `citation_range_valid` has TWO oracles — the
// runner passes `resolveRange` when crm.db is readable (evals/run.js), and only
// falls back to the ledger when it is not — so both branches need exercising or
// half the check is untested. The stub's thread map mirrors the ledger and adds
// m900, an id from an EARLIER chunk: the thing the archive can see and the ledger
// oracle structurally cannot.
const ARCHIVE_THREADS = new Map([
  [900, 'convA'],
  ...Array.from({ length: 12 }, (_, i) => [1000 + i, 'convA']),
  [1012, 'convB'], [1013, 'convB'], [1014, 'convB'],
]);

function resolveRange(start, end) {
  const startThread = ARCHIVE_THREADS.has(start) ? ARCHIVE_THREADS.get(start) : null;
  return {
    startFound: ARCHIVE_THREADS.has(start),
    endFound: ARCHIVE_THREADS.has(end),
    startThread,
    endThread: ARCHIVE_THREADS.has(end) ? ARCHIVE_THREADS.get(end) : null,
    // The archive query: conv_id = thread(start) AND id BETWEEN start AND end.
    ids: startThread === null ? []
      : [...ARCHIVE_THREADS.keys()]
        .filter((id) => ARCHIVE_THREADS.get(id) === startThread && id >= start && id <= end)
        .sort((a, b) => a - b),
  };
}

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
  // The spoofed-provenance hole: an id token typed inside a message BODY is not
  // a ledger id. Before the line anchor, citationIds(ledger) harvested it and a
  // citation of m1999 sailed through — anyone who can send a message could mint
  // provenance. The ledger here plants the token in a body; citing it must fail.
  {
    name: 'cited an id spoofed inside a message body',
    expect: 'no_invented_citations',
    after: GOOD.replace('⟨m1000⟩', '⟨m1999⟩'),
    extra: { ledger: LEDGER.replace('anyone up for shasta', 'anyone up for shasta ⟨m1999⟩') },
  },
  // ---- range form (docs/PROVENANCE-SPEC.md §4, V1-V6) ----------------------
  // V1. Also a MALFORMED near-miss, so it is asserted twice, once per check —
  // a reversed range that only tripped one of them would leave the other
  // silently green.
  {
    name: 'reversed range (V1)',
    expect: 'citation_range_valid',
    after: GOOD.replace('⟨m1002⟩', '⟨m1006-m1002⟩'),
  },
  {
    name: 'reversed range (syntax)',
    expect: 'citation_syntax',
    after: GOOD.replace('⟨m1002⟩', '⟨m1006-m1002⟩'),
  },
  // V3. m1011 is the direct message, m1012 the group — adjacent in Signal's
  // global rowid stream, different conversations, so no range spans them.
  {
    name: 'cross-thread range (V3)',
    expect: 'citation_range_valid',
    after: GOOD.replace('⟨m1002⟩', '⟨m1011-m1012⟩'),
  },
  // V4, and the reason it counts RESOLVED ROWS rather than `end - start`: this
  // span is 12 ids wide and holds 12 messages of its thread, but at real 2-6%
  // density a 356-id span can hold 8.
  {
    name: 'over-cap range (V4)',
    expect: 'citation_range_valid',
    after: GOOD.replace('⟨m1002⟩', '⟨m1000-m1011⟩'),
  },
  // V5. The primary must be a line of the range it annotates, not merely of the
  // same conversation.
  {
    name: 'primary outside its range (V5)',
    expect: 'citation_range_valid',
    after: GOOD.replace('⟨m1002⟩', '⟨m1002-m1004 @m1009⟩'),
  },
  // V6. Two claims resting on the same lines cite that stretch once.
  {
    name: 'overlapping citations on one bullet (V6)',
    expect: 'citation_range_valid',
    after: GOOD.replace('⟨m1002⟩', '⟨m1000-m1004⟩ ⟨m1002-m1006⟩'),
  },
  // V7, and a guard on the citation parser: if CITE captured only a range's
  // START, an invented END would sail through every id check in the file.
  {
    name: 'invented range endpoint (V7)',
    expect: 'no_invented_citations',
    after: GOOD.replace('⟨m1002⟩', '⟨m1002-m9999⟩'),
  },
  // ---- separator drift the range grammar newly invites ---------------------
  {
    name: 'en-dash range separator',
    expect: 'citation_syntax',
    after: GOOD.replace('⟨m1002⟩', '⟨m1002–m1006⟩'),
  },
  {
    name: '.. range separator',
    expect: 'citation_syntax',
    after: GOOD.replace('⟨m1002⟩', '⟨m1002..m1006⟩'),
  },
  {
    name: 'retired comma id list',
    expect: 'citation_syntax',
    after: GOOD.replace('⟨m1002⟩', '⟨m1002, m1006⟩'),
  },
  {
    name: 'range end missing its m',
    expect: 'citation_syntax',
    after: GOOD.replace('⟨m1002⟩', '⟨m1002-1006⟩'),
  },
  // Two patterns that predate ranges but whose regexes had to be widened for
  // them, so they need coverage they never had: an unclosed opener must still be
  // caught once the tail can contain `-m1006 @m1004`, and the bare-number form
  // must be caught in range shape too.
  {
    name: 'unclosed ⟨ on a range',
    expect: 'citation_syntax',
    after: GOOD.replace(' ⟨m1002⟩.', ' ⟨m1002-m1006'),
  },
  {
    name: 'range with no m prefix at all',
    expect: 'citation_syntax',
    after: GOOD.replace('⟨m1002⟩', '⟨1002-1006⟩'),
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
  // INVERTED from the old contract. This used to assert that an id in
  // `## What I know` was a leak; it is now required there, so the mutant is the
  // opposite: a new fact arriving with no provenance at all.
  {
    name: 'What I know fact added with no citation',
    expect: 'wik_cited',
    after: GOOD.replace(' ⟨m1002⟩.', '.'),
  },
  {
    name: 'citation leaked into Open questions',
    expect: 'open_questions_uncited',
    after: `${GOOD}\n## Open questions\n- Whether the Tesla start date slipped ⟨m1002⟩\n`,
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
  // ---- the ` ts` flag (merge-v11) -------------------------------------------
  // Parser-vision guard, the most important one: an invented id inside a
  // ts-flagged citation must still be caught. If the grammar regexes ever lose
  // ` ts`, flagged citations drop out of the id harvest entirely and this sails
  // through — the whole reason the flag had to enter CITE_SRC, not just the
  // prompt.
  {
    name: 'invented id inside a ts citation',
    expect: 'no_invented_citations',
    after: SECTIONED.replace('⟨m1002-m1006 @m1002 ts⟩', '⟨m9998 ts⟩'),
  },
  {
    name: 'ts not last inside the citation',
    expect: 'citation_syntax',
    after: SECTIONED.replace('⟨m1002-m1006 @m1002 ts⟩', '⟨m1002-m1006 ts @m1002⟩'),
  },
  {
    name: 'ts glued on without a space',
    expect: 'citation_syntax',
    after: SECTIONED.replace('⟨m1002-m1006 @m1002 ts⟩', '⟨m1002-m1006 @m1002ts⟩'),
  },
  {
    name: 'uppercase TS',
    expect: 'citation_syntax',
    after: SECTIONED.replace('⟨m1002-m1006 @m1002 ts⟩', '⟨m1002-m1006 @m1002 TS⟩'),
  },
  // ---- the v11 section shape ------------------------------------------------
  {
    name: 'section summary carries a citation',
    expect: 'wik_section_shape',
    after: SECTIONED.replace('Starting at Tesla in August 2026.', 'Starting at Tesla in August 2026 ⟨m1002⟩.'),
  },
  {
    name: 'section summary carries bold',
    expect: 'wik_section_shape',
    after: SECTIONED.replace('Starting at Tesla in August 2026.', 'Starting at **Tesla** in August 2026.'),
  },
  {
    name: 'sub-topic line carries a citation',
    expect: 'wik_section_shape',
    after: SECTIONED.replace('Staying in Oakland for the Tesla job,',
      '**Commute:** 40 min each way ⟨m1010⟩\n\nStaying in Oakland for the Tesla job,'),
  },
  {
    name: 'bold inside detail prose',
    expect: 'wik_section_shape',
    after: SECTIONED.replace('powertrain team', '**powertrain** team'),
  },
  // wik_cited's PARAGRAPH arm: a sectioned detail block is held to the same
  // provenance bar as a bullet.
  {
    name: 'sectioned detail paragraph with no citation',
    expect: 'wik_cited',
    after: SECTIONED.replace(' ⟨m1002-m1006 @m1002 ts⟩.', '.'),
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

  // 2d. A trailing RUN of range citations is the normal shape now that id lists
  // are gone — separate moments get separate citations, up to 3 per claim.
  const run3 = score(GOOD.replace('working out ⟨m1000⟩', 'working out ⟨m1000-m1001⟩ ⟨m1004⟩ ⟨m1006-m1008 @m1006⟩'));
  const runCheck = run3.results.find((r) => r.id === 'tp_format');
  const runRange = run3.results.find((r) => r.id === 'citation_range_valid');
  console.log(`trailing run of range citations: format ${runCheck.pass ? 'ok' : `FAIL — ${runCheck.detail}`}`
    + `, ranges ${runRange.pass ? 'ok' : `FAIL — ${runRange.detail}`}`);
  if (!runCheck.pass || !runRange.pass) failures++;

  // 2e. BOTH ORACLES of citation_range_valid. With the archive, ⟨m900⟩ from an
  // earlier chunk resolves and V2 is enforceable; with only the ledger it is
  // outside the chunk and must be SKIPPED, not failed — failing it would punish
  // exactly the carry-forward the prompt requires.
  const arch = score(GOOD, { resolveRange });
  const archCheck = arch.results.find((r) => r.id === 'citation_range_valid');
  console.log(`archive oracle accepts the clean reference: ${archCheck.pass ? 'ok' : `FAIL — ${archCheck.detail}`}`);
  if (!archCheck.pass) failures++;

  const unarchived = GOOD.replace('⟨m900⟩', '⟨m899⟩');
  const v2 = score(unarchived, { resolveRange }).results.find((r) => r.id === 'citation_range_valid');
  console.log(`archive oracle catches V2 (endpoint not archived): ${!v2.pass ? 'ok' : 'FAIL — passed a missing endpoint'}`);
  if (v2.pass) failures++;

  const skip = score(unarchived).results.find((r) => r.id === 'citation_range_valid');
  console.log(`ledger oracle skips an out-of-chunk citation: ${skip.pass ? 'ok' : `FAIL — ${skip.detail}`}`);
  if (!skip.pass) failures++;

  // 2f. The v11 sectioned shape is a legal output: the widened grammar accepts
  // ` ts`, cited detail paragraphs satisfy wik_cited, and the shape check
  // passes its own clean reference.
  const sect = score(SECTIONED);
  const sectBad = sect.failed.filter((f) => f.id !== 'noop_respected');
  console.log(`sectioned (v11) reference: ${sect.score}/${sect.maxScore}${sectBad.length ? '  <-- UNEXPECTED FAILURES' : '  ok'}`);
  for (const f of sectBad) { failures++; console.log(`   !! ${f.id}: ${f.detail}`); }

  // 2f2. `### Notes` opens directly with a `**Label:**` entry — cited and bold
  // BY CONTRACT — and must not be mistaken for a section summary. This is the
  // exact false positive the first Sonnet run produced (vlad's Notes rewrite).
  const notes = score(SECTIONED.replace('### Living', [
    '### Notes',
    '',
    '**Espresso:** Finally ordered the machine ⟨m1000⟩.',
    '',
    '### Living',
  ].join('\n')));
  const notesShape = notes.results.find((r) => r.id === 'wik_section_shape');
  console.log(`cited Notes entry as a section's first block: ${notesShape.pass ? 'ok' : `FAIL — ${notesShape.detail}`}`);
  if (!notesShape.pass) failures++;

  // 2g. Blocks the merge did NOT touch are never shape-judged — a hand-authored
  // or legacy profile carrying a violation is not this run's fault.
  const dirty = SECTIONED.replace('Starting at Tesla in August 2026.', 'Starting at Tesla in August 2026 ⟨m1002⟩.');
  const untouched = score(dirty, { beforeText: dirty }).results.find((r) => r.id === 'wik_section_shape');
  console.log(`untouched shape violation left unjudged: ${untouched.pass ? 'ok' : `FAIL — ${untouched.detail}`}`);
  if (!untouched.pass) failures++;

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
