'use strict';
// lib/task-trigger.js — find the lines where Nathan asked for a task to be tracked.
//
// THE WHOLE DESIGN IN ONE SENTENCE: a regex decides WHETHER something is a task, and the
// model only works out WHAT it is.
//
// WHY IT ENDED UP HERE. The first design had an LLM read a whole ledger and judge, from
// scratch, which commitments deserved tracking. That question turned out to have no stable
// answer — four rounds of prompt amendments (Nathan-only, ask-gated, non-routine,
// importance-scored, refusal-aware, opt-in) grew the prompt from 9.5KB to 27KB, and the
// eval still landed at 80% precision with 67% recall on a six-task gold set. Every round
// was Nathan telling me the model's taste was wrong, which is the signal that taste was
// the wrong thing to automate.
//
// Nathan's call: "lets just scan for 'make sure'. i will just say it in the future. it is
// not important that every past task is picked up."
//
// What that buys:
//   - Precision is his, not the model's. If he said it, it is a task. No calibration.
//   - A ledger with no match costs ZERO model calls.
//   - The prompt collapses from 4,600 words to ~1,000, and most of the eval apparatus
//     (gold set, tiering, ask/routine/refusal heuristics) stops being load-bearing.
//
// What it costs, knowingly:
//   - No retroactive capture. He has never said the phrase, so the 80,000-message archive
//     yields nothing. Real past commitments — the unfinished rush business cards, the
//     move-in help — stay uncaptured. He accepted this explicitly.
//   - Silent failure. Forget the phrase and the task simply does not exist. There is no
//     "did you mean" path, by design.

// AN EXPLICIT FIRST-PERSON SUBJECT IS REQUIRED, and this is the whole ballgame.
//
// The first version of this accepted bare "make sure to X". Measured against the real
// archive, that fires 25 times in two years and essentially none are tasks — because
// English drops the subject in imperatives, so "make sure to X" almost always means YOU
// make sure. The actual matches were "make sure to drink water", "make sure to take the
// 280", "make sure to wear a swimsuit in case you get wet", "make sure to carry a
// firearm". A todo list of advice Nathan gave other people is the exact failure the
// simplification was meant to escape.
//
// Requiring a first-person subject cuts 25 -> 7 (0.29/month). Restricting further to
// FUTURE-COMMITMENT forms — which is literally what Nathan specified, "i'll make sure to"
// — cuts it to 4 (0.17/month), and drops the two remaining categories that are not
// commitments at all: immediate self-checks ("lemme make sure walmart is open") and past
// tense ("i need to make sure that i had it on the way in").
//
// Chosen: future-commitment forms only. A trigger this deliberate should not also fire on
// thinking-out-loud, and "lemme make sure X" is something he says while doing X, not
// something he says to remember X.
const { redact } = require('./redact');

const SELF = [
  /\bi'?ll\s+make sure\b/i,
  /\bi\s+will\s+make sure\b/i,
  /\b(?:i'?m\s+gonna|im\s+gonna|imma)\s+make sure\b/i,
];

// Second person or third person: "make sure you send it" is a request TO the contact.
// Only consulted for reporting a near-miss — a self-directed match always wins, because
// "i'll make sure you get the deck" is second-person in grammar but Nathan's task in fact.
const OTHER = /\bmake sure (?:you|u|ya|he|she|they|we|everyone|its|it'?s|that (?:you|he|she|they|we))\b/i;

function isTrigger(body) {
  const b = String(body || '');
  if (!/make sure/i.test(b)) return false;          // cheap gate first
  return SELF.some((r) => r.test(b));
}

// Exported separately so the CLI can explain a near-miss rather than silently ignoring it.
// A line containing "make sure" that does NOT trigger is worth telling Nathan about: it is
// the case where he meant to opt in and phrased it in a way the scan does not accept, and
// the failure would otherwise be invisible.
function isNearMiss(body) {
  const b = String(body || '');
  return /make sure/i.test(b) && !isTrigger(b);
}

// A ledger line: `[YYYY-MM-DD HH:MM] ⟨m123⟩ Sender: body`
const LINE = /^\[([^\]]+)\]\s*⟨m(\d+)⟩\s*(?:\(([^)]*)\)\s*)?([^:]+):\s?([\s\S]*)$/;

function parseLedger(text) {
  const msgs = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) msgs.push({ when: m[1], id: Number(m[2]), group: m[3] || null, sender: m[4].trim(), body: m[5] });
  }
  return msgs;
}

// Ledger timestamps are PACIFIC and carry date + time but not the weekday, so resolving
// "ill be out until tuesday" needs calendar arithmetic the model should not have to do in
// its head. Stating the weekday makes a whole class of deadline error impossible: the pine
// case is a Saturday, so "tuesday" is +3 days, and getting that wrong by a week is the
// difference between a useful reminder and a wrong one.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function weekdayOf(when) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(when));
  if (!m) return null;
  // Constructed as a LOCAL date deliberately: the ledger string is already Pacific, and
  // `new Date('2026-05-23')` would parse as UTC midnight and land on the previous day for
  // anyone west of Greenwich.
  return WEEKDAYS[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()];
}

const BEFORE = 25;   // enough to find what "it" refers to
const AFTER = 8;     // enough to catch "nvm" or an immediate discharge

// Build one context window per trigger. The triggered line is marked `>>> ` so the model
// cannot mistake which commitment it is describing — with several windows in one call, an
// unmarked format would let it conflate them.
function findTriggers(ledgerText, { before = BEFORE, after = AFTER, owner = 'Nathan' } = {}) {
  const msgs = parseLedger(ledgerText);
  const hits = [];
  const nearMisses = [];
  msgs.forEach((m, i) => {
    if (m.sender !== owner) return;
    if (isTrigger(m.body)) hits.push({ i, msg: m });
    else if (isNearMiss(m.body)) nearMisses.push(m);
  });

  const windows = hits.map(({ i, msg }) => {
    const lo = Math.max(0, i - before);
    const hi = Math.min(msgs.length - 1, i + after);
    const lines = [];
    const ids = [];
    for (let j = lo; j <= hi; j += 1) {
      const x = msgs[j];
      ids.push(x.id);
      lines.push(`${j === i ? '>>> ' : '    '}[${x.when}] ⟨m${x.id}⟩ ${x.sender}: ${redact(x.body)}`);
    }
    return {
      msgId: msg.id,
      when: msg.when,
      weekday: weekdayOf(msg.when),
      body: msg.body,
      // Every id the model can see in this window — the contract for which ids a
      // task's citation range may name (crm-tasks clamps against it).
      ids,
      text: lines.join('\n'),
    };
  });

  return { windows, nearMisses, total: msgs.length };
}

// The {{MESSAGES}} payload: every window, separated so they are visibly distinct.
function renderWindows(windows) {
  return windows
    .map((w, n) => `--- trigger ${n + 1} of ${windows.length} · ⟨m${w.msgId}⟩ · sent ${w.weekday} ${w.when} Pacific ---\n${w.text}`)
    .join('\n\n');
}

module.exports = { isTrigger, isNearMiss, findTriggers, renderWindows, parseLedger, weekdayOf, SELF, OTHER };
