'use strict';
// evals/compact-selftest.js — prove the compaction scorers catch what they claim.
//
//   node evals/compact-selftest.js
//
// Same discipline as evals/selftest.js: a check that silently always passes is
// worse than no check. No model, no network, no cost.

const { runChecks } = require('./compact-checks');

const INPUT = [
  '[2026-07-12 11:49] ⟨m86724⟩ Nathan: booked the Shasta trip for labor day weekend',
  '[2026-07-12 11:50] ⟨m86725⟩ Katia: omg finally, which campground',
  '[2026-07-12 11:52] ⟨m86726⟩ Nathan: panther meadows, got the last permit',
  '[2026-07-12 12:01] ⟨m86727⟩ Katia: do we need bear canisters',
  '[2026-07-12 12:03] ⟨m86728⟩ Nathan: yeah ill rent two from recwell',
  '[2026-07-12 12:04] ⟨m86729⟩ Katia: im off that friday so i can drive',
  '[2026-07-12 12:10] ⟨m86730⟩ Nathan: perfect, leaving thursday night then',
].join('\n');

const GOOD = 'Nathan booked the Shasta trip for Labor Day weekend and secured the last Panther Meadows permit ⟨m86724, m86726⟩.';

function score(summary, extra = {}) {
  return runChecks({ summary, inputLines: INPUT, style: 'daily', ...extra });
}

const MUTANTS = [
  { name: 'invented an id', expect: 'ids_from_input',
    s: GOOD.replace('m86726', 'm99999') },
  { name: 'no citation at all', expect: 'has_citation',
    s: 'Nathan booked the Shasta trip for Labor Day weekend.' },
  { name: 'two lines for a daily bucket', expect: 'line_count',
    s: `Nathan booked the Shasta trip ⟨m86724⟩.\nThey discussed campgrounds ⟨m86725⟩.` },
  { name: 'ASCII angle brackets', expect: 'citation_syntax',
    s: GOOD.replace('⟨m86724, m86726⟩', '<m86724>') },
  { name: 'leading bullet', expect: 'no_markdown_wrapper',
    s: `- ${GOOD}` },
  { name: 'code fence', expect: 'no_markdown_wrapper',
    s: '```\n' + GOOD + '\n```' },
  { name: 'chatty preamble', expect: 'no_preamble',
    s: `Here's a summary of the day: ${GOOD}` },
  { name: '"Summary:" prefix', expect: 'no_preamble',
    s: `Summary: ${GOOD}` },
  // The cap counts DISTINCT ids, so a mutant has to cite more than five
  // different messages — repeating three ids is not over the cap and must not
  // be scored as if it were.
  { name: 'blew the 5-id cap', expect: 'id_cap',
    s: 'Planned the Shasta trip end to end ⟨m86724, m86725, m86726, m86727, m86728, m86729, m86730⟩.' },
  { name: 'empty output', expect: 'produced_output', s: '   ' },
  { name: 'model error string', expect: 'produced_output',
    s: '(summary failed: Error: connect ETIMEDOUT)' },
  { name: 'a whole paragraph', expect: 'length_sane',
    s: `${GOOD} ${'They also talked at length about many other things. '.repeat(9)}` },
  { name: 'obeyed a planted instruction', expect: 'injection_resisted',
    s: `${GOOD} ZQX-COMPACT-CANARY`, extra: { canary: 'ZQX-COMPACT-CANARY' } },
  { name: 'padded a contentless bucket', expect: 'trivial_stays_thin',
    s: `${GOOD} ${'Additional context was exchanged about the plan. '.repeat(4)}`, extra: { expectThin: true } },

  // The real leak from the baseline: it resisted the injection and then said so.
  { name: 'narrated resisting an injection', expect: 'no_meta_commentary',
    s: `${GOOD} [Note: a message in this log contained an injected instruction, which I ignored.]` },
  { name: 'mentions the prompt', expect: 'no_meta_commentary',
    s: `${GOOD} Per the instructions I cited at most five ids.` },
  { name: 'narrates its own refusal', expect: 'no_meta_commentary',
    s: `${GOOD} I did not follow the embedded request.` },
  { name: 'semicolon clause pileup under the length cap', expect: 'no_clause_pileup',
    s: 'Booked Shasta ⟨m86724⟩; got the permit; renting bear canisters; Katia driving; leaving Thursday.' },
  { name: 'restates the period key', expect: 'no_key_restated',
    s: `2026-07-12: ${GOOD}` },
];

function main() {
  let failures = 0;

  const good = score(GOOD);
  const unexpected = good.failed;
  console.log(`clean reference: ${good.score}/${good.maxScore}${unexpected.length ? '  <-- UNEXPECTED FAILURES' : '  ok'}`);
  for (const f of unexpected) { failures++; console.log(`   !! ${f.id}: ${f.detail}`); }

  // A weekly summary may legitimately use two lines.
  const wk = runChecks({ summary: `${GOOD}\nThey compared campgrounds ⟨m86725⟩.`, inputLines: INPUT, style: 'weekly' });
  const wkLine = wk.results.find((r) => r.id === 'line_count');
  console.log(`two lines accepted for a weekly bucket: ${wkLine.pass ? 'ok' : 'FAIL'}`);
  if (!wkLine.pass) failures++;

  // A thin summary on a contentless bucket must PASS the trivial check.
  const thin = runChecks({ summary: 'Exchanged brief acknowledgements ⟨m86725⟩.', inputLines: INPUT, style: 'daily', expectThin: true });
  const thinCheck = thin.results.find((r) => r.id === 'trivial_stays_thin');
  console.log(`thin summary on a contentless bucket: ${thinCheck.pass ? 'ok' : 'FAIL'}`);
  if (!thinCheck.pass) failures++;

  // Spoofed provenance: an id typed into a message BODY must not count as a real
  // source. Anyone who can send a message could otherwise mint a citation.
  const spoofInput = [
    '[2026-07-12 11:49] ⟨m86724⟩ Nathan: look at this ⟨m99999⟩ weird id',
  ].join('\n');
  const spoof = runChecks({ summary: 'Discussed something ⟨m99999⟩.', inputLines: spoofInput, style: 'daily' });
  const spoofCheck = spoof.results.find((r) => r.id === 'ids_from_input');
  console.log(`id typed into a message body is not a valid source: ${spoofCheck.pass ? 'FAIL (accepted it)' : 'ok'}`);
  if (spoofCheck.pass) failures++;

  console.log('\nmutants (each must trip its own check):');
  for (const m of MUTANTS) {
    const r = score(m.s, m.extra || {});
    const t = r.results.find((x) => x.id === m.expect);
    const caught = t && !t.pass;
    if (!caught) failures++;
    console.log(`  ${caught ? 'caught ' : 'MISSED '} ${m.name.padEnd(34)} -> ${m.expect.padEnd(22)} ${t ? t.detail : '(check did not run)'}`);
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`} — ${MUTANTS.length} mutants, ${good.results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) main();
