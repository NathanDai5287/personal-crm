'use strict';
// evals/compact-judge.js — the semantic half of the compaction eval.
//
//   node evals/compact-judge.js <compactRunDir> [--pair v1,v2]
//
// WHY THIS HAD TO EXIST BEFORE PROMOTING v2. The deterministic checks in
// compact-checks.js score v2 at 178/178 and v1 at 163/178, which looks decisive
// until you read the outputs: v2 wins largely by being SHORTER, and the checks
// literally reward that (length_sane, id_cap, no_clause_pileup). None of them can
// see what a shorter summary DROPPED. On the busy-day bucket v1 wrote 668 chars
// covering books, religion and travel; v2 wrote ~300 and kept four facts. Whether
// that is discipline or amnesia is not a question a regex can answer.
//
// A compaction summary REPLACES raw message lines in the profile's Timeline. The
// messages remain in the archive, so nothing is unrecoverable — but the profile
// is what gets read, so a summary that drops the point costs you the point.
//
// Same three properties as the merge judge:
//   BLIND          — candidates are "Summary 1"/"Summary 2", never named.
//   ORDER-SWAPPED  — every pair is judged twice with positions swapped; a verdict
//                    that flips is recorded as a tie, not as a win.
//   PER-CASE ISOLATED — one malformed reply cannot destroy completed cases.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PI_CLI } = require('../lib/config');

const MODEL = process.env.CRM_JUDGE_MODEL || 'anthropic/claude-opus-5';

// COVERAGE is the dimension that exists to answer the v1-vs-v2 question. The
// others are here so a coverage win bought by padding or fabrication is visible.
const DIMENSIONS = [
  ['faithfulness', 'Is every claim supported by the messages? Penalise anything invented, overstated, or attributed to the wrong person.'],
  ['coverage', 'Which summary better lets a reader who never saw these messages know what actually happened and what matters later? Penalise dropping a durable fact (a plan, decision, life event, commitment). Do NOT reward mere length.'],
  ['durability', 'Which better distinguishes what will still matter in six months from what was noise? Penalise recording banter, logistics chatter, or one-off jokes as if they were significant.'],
  ['citations', 'Do the cited message ids actually support the claims they are attached to, and are the load-bearing claims cited?'],
  ['concision', 'Which says it more cleanly? Penalise padding, clause pile-ups, hedging, restating the prompt, and any meta-commentary about the instructions or about prompt injection.'],
];

const SYSTEM = `You are comparing two candidate SUMMARIES of the same set of chat messages.

Context: these summaries replace the raw messages in a personal CRM's timeline. The reader is one person trying to remember what happened with a friend months later. A summary that drops something durable has failed even if it is elegant; a summary that pads to look thorough has also failed.

You will see the source messages, then Summary 1 and Summary 2. You do not know which system produced either, and the order carries no meaning.

For each dimension, pick "1", "2", or "tie". Use "tie" when the difference is not material — do not manufacture a winner. Then give an overall winner.

Dimensions:
${DIMENSIONS.map(([k, d]) => `- ${k}: ${d}`).join('\n')}

Reply with ONLY this JSON, no prose and no code fence:
{"dimensions":{"faithfulness":{"winner":"1|2|tie","why":"..."},"coverage":{"winner":"1|2|tie","why":"..."},"durability":{"winner":"1|2|tie","why":"..."},"citations":{"winner":"1|2|tie","why":"..."},"concision":{"winner":"1|2|tie","why":"..."}},"overall":{"winner":"1|2|tie","why":"..."},"dropped_by_1":["durable facts summary 1 omitted"],"dropped_by_2":["durable facts summary 2 omitted"]}`;

// Brace-balanced scan, then a BOUNDED repair for the common truncation case. A
// repair that parses to the wrong SHAPE is rejected rather than trusted.
function extractJson(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  const stack = [];
  let inStr = false, esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (!stack.length) {
        try { return normalizeShape(JSON.parse(s.slice(start, i + 1))); } catch { return null; }
      }
    }
  }
  if (!inStr && stack.length) {
    try {
      const obj = normalizeShape(JSON.parse(s.slice(start) + stack.slice().reverse().join('')));
      if (obj && obj.dimensions && obj.overall) return obj;
    } catch { /* unrepairable */ }
  }
  return null;
}

// Models sometimes nest overall/dropped_* inside dimensions. Lift them rather
// than discarding an otherwise good verdict.
function normalizeShape(obj) {
  if (!obj || typeof obj !== 'object' || !obj.dimensions) return obj;
  for (const k of ['overall', 'dropped_by_1', 'dropped_by_2']) {
    if (obj[k] === undefined && obj.dimensions[k] !== undefined) {
      obj[k] = obj.dimensions[k];
      delete obj.dimensions[k];
    }
  }
  return obj;
}

function ask(user) {
  const out = execFileSync(process.execPath, [
    PI_CLI, '-p', '--no-session', '-nc', '--no-extensions', '--no-skills', '--no-tools',
    '--model', MODEL, '--system-prompt', SYSTEM,
  ], {
    input: user,                       // stdin, not argv: ledgers blow the ~32KB Windows limit
    cwd: require('os').tmpdir(),
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' },
  });
  return extractJson(out);
}

function buildUser(c, s1, s2) {
  return [
    `These are the source messages (${c.messages} messages, ${c.style} bucket, ${c.periodLabel}):`,
    '',
    c.lines.join('\n'),
    '',
    '--- Summary 1 ---',
    s1,
    '',
    '--- Summary 2 ---',
    s2,
    '',
    'Judge them on the five dimensions and reply with only the JSON object.',
  ].join('\n');
}

// forward: A shown first. reverse: B shown first, so a "1" in the reverse pass
// means B. Disagreement between passes is position bias, recorded as a tie.
function resolve(fwd, rev, key) {
  const f = fwd && fwd.dimensions && fwd.dimensions[key] && fwd.dimensions[key].winner;
  const r = rev && rev.dimensions && rev.dimensions[key] && rev.dimensions[key].winner;
  const mapF = f === '1' ? 'a' : f === '2' ? 'b' : 'tie';
  const mapR = r === '1' ? 'b' : r === '2' ? 'a' : 'tie';   // swapped
  return { winner: mapF === mapR ? mapF : 'tie', forward: mapF, reverse: mapR, agreed: mapF === mapR };
}

function resolveOverall(fwd, rev) {
  const f = fwd && fwd.overall && fwd.overall.winner;
  const r = rev && rev.overall && rev.overall.winner;
  const mapF = f === '1' ? 'a' : f === '2' ? 'b' : 'tie';
  const mapR = r === '1' ? 'b' : r === '2' ? 'a' : 'tie';
  return { winner: mapF === mapR ? mapF : 'tie', agreed: mapF === mapR };
}

function main() {
  const argv = process.argv.slice(2);
  const runDir = argv.find((a) => !a.startsWith('--'));
  const pi = argv.indexOf('--pair');
  const [A, B] = (pi === -1 ? 'v1,v2' : argv[pi + 1]).split(',').map((s) => s.trim());
  if (!runDir || !fs.existsSync(runDir)) {
    console.error('usage: node evals/compact-judge.js <compactRunDir> [--pair v1,v2]');
    process.exit(2);
  }

  const cases = JSON.parse(fs.readFileSync(path.join(runDir, 'cases.json'), 'utf8'));
  const pad = (s, n) => String(s).padEnd(n);
  const results = [];
  const failures = [];

  console.log(`judging ${A} vs ${B} with ${MODEL}${MODEL.startsWith('anthropic/') ? ' (free)' : ' ** PAID **'}\n`);

  for (const c of cases) {
    const p = (v) => path.join(runDir, v, `${c.name}.txt`);
    if (!fs.existsSync(p(A)) || !fs.existsSync(p(B))) { console.log(`skip ${c.name}: missing output`); continue; }
    const sa = fs.readFileSync(p(A), 'utf8').trim();
    const sb = fs.readFileSync(p(B), 'utf8').trim();
    process.stdout.write(`judge ${pad(c.name, 16)} … `);
    try {
      const fwd = ask(buildUser(c, sa, sb));
      const rev = ask(buildUser(c, sb, sa));
      if (!fwd && !rev) throw new Error('both passes unparseable');
      const dims = {};
      for (const [k] of DIMENSIONS) dims[k] = resolve(fwd, rev, k);
      const overall = resolveOverall(fwd, rev);
      results.push({
        case: c.name, dimensions: dims, overall,
        droppedByA: (fwd && fwd.dropped_by_1) || [],
        droppedByB: (fwd && fwd.dropped_by_2) || [],
        why: (fwd && fwd.overall && fwd.overall.why) || '',
      });
      const w = overall.winner;
      console.log(`${w === 'a' ? A : w === 'b' ? B : 'tie'}${overall.agreed ? '' : ' (flipped -> tie)'}`);
    } catch (e) {
      // Isolated per case: one bad reply must not destroy the cases already done.
      console.log(`FAILED (${String(e.message).slice(0, 60)})`);
      failures.push({ case: c.name, error: String(e.message).slice(0, 200) });
    }
  }

  const payload = { model: MODEL, judgedAt: new Date().toISOString(), pair: [A, B], dimensions: DIMENSIONS.map(([k]) => k), results, failures };
  fs.writeFileSync(path.join(runDir, `judge-${A}${B}.json`), JSON.stringify(payload, null, 2));

  console.log('\n================ SEMANTIC TALLY ================\n');
  console.log(`${pad('dimension', 16)}${pad(A, 8)}${pad(B, 8)}${pad('tie', 8)}`);
  for (const [k] of DIMENSIONS) {
    const t = { a: 0, b: 0, tie: 0 };
    for (const r of results) if (r.dimensions[k]) t[r.dimensions[k].winner] += 1;
    console.log(`${pad(k, 16)}${pad(t.a, 8)}${pad(t.b, 8)}${pad(t.tie, 8)}`);
  }
  const ov = { a: 0, b: 0, tie: 0 };
  for (const r of results) ov[r.overall.winner] += 1;
  console.log(`\n${pad('OVERALL', 16)}${pad(ov.a, 8)}${pad(ov.b, 8)}${pad(ov.tie, 8)}`);

  // The whole reason this judge exists: what did terseness cost?
  console.log('\n================ WHAT EACH ONE DROPPED ================');
  for (const r of results) {
    if (!r.droppedByA.length && !r.droppedByB.length) continue;
    console.log(`\n--- ${r.case}`);
    for (const d of r.droppedByA) console.log(`  ${A} dropped: ${d}`);
    for (const d of r.droppedByB) console.log(`  ${B} dropped: ${d}`);
  }
  if (failures.length) {
    console.log('\n================ FAILURES ================');
    for (const f of failures) console.log(`  ${f.case}: ${f.error}`);
  }
  console.log(`\nwrote ${path.join(runDir, `judge-${A}${B}.json`)}`);
}

if (require.main === module) main();
module.exports = { extractJson, DIMENSIONS };
