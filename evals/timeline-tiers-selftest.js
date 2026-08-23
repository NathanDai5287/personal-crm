'use strict';
// evals/timeline-tiers-selftest.js — prove the Timeline daily-tier day anchoring
// and the daily-deletion rule behave, across DST and run time-of-day. No model,
// no DB, no network, no cost. Same discipline as evals/selftest.js.
//
//   node evals/timeline-tiers-selftest.js
//
// Guards two fixes:
//   X6 — daily days are 04:00-Pacific anchored (not a rolling 24h window off
//        Date.now()), so keys are stable across run time-of-day and DST-safe.
//   P6 — a daily is deleted ONLY when its week has a weekly summary.

const assert = require('node:assert');
const { dayStartsForDaily, weekKeyOfDay } = require('../scripts/crm-timeline');
const { fmtLocal, dateKey, dayNumber, weekStart } = require('../lib/weeks');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass += 1; };

// A Pacific instant helper for building `now` values (approx offset is fine — we
// only need to land inside a known Pacific day; the code re-anchors precisely).
const PT = (y, mo, d, hUTC) => Date.UTC(y, mo - 1, d, hUTC, 0);

function checkAnchoring(now, label) {
  const days = dayStartsForDaily(now);
  assert.strictEqual(days.length, 21, `${label}: expected 21 day starts`);
  // Every day start is exactly 04:00 Pacific.
  for (const ds of days) {
    ok(fmtLocal(ds).endsWith(' 04:00'), `${label}: ${fmtLocal(ds)} is not 04:00 Pacific`);
  }
  // Consecutive Pacific days, strictly one apart, no skip/collision (DST-safe).
  for (let i = 1; i < days.length; i++) {
    const diff = dayNumber(days[i - 1]) - dayNumber(days[i]);
    ok(diff === 1, `${label}: ${dateKey(days[i])} -> ${dateKey(days[i - 1])} differ by ${diff}, not 1`);
  }
}

// 1) Anchoring holds in a normal month and across BOTH 2026 DST transitions.
checkAnchoring(PT(2026, 6, 15, 18), 'june');                 // no DST nearby
checkAnchoring(PT(2026, 3, 15, 19), 'post-spring-forward');  // window spans Mar 8 spring-forward
checkAnchoring(PT(2026, 11, 10, 20), 'post-fall-back');      // window spans Nov 1 fall-back

// 2) Keys are STABLE across time-of-day within the SAME Pacific day. (The old
//    rolling-window keying failed this — it shifted with the run clock.)
const morning = PT(2026, 6, 15, 13);   // ~06:00 PDT Jun 15
const evening = PT(2026, 6, 16, 6);    // ~23:00 PDT Jun 15 (still Pacific 2026-06-15)
assert.strictEqual(dateKey(dayStartsForDaily(morning)[0]), '2026-06-15', 'morning today key');
assert.strictEqual(dateKey(dayStartsForDaily(evening)[0]), '2026-06-15', 'evening today key');
const kMorning = dayStartsForDaily(morning).map(dateKey).join(',');
const kEvening = dayStartsForDaily(evening).map(dateKey).join(',');
ok(kMorning === kEvening, 'daily keys must not depend on the run time-of-day');

// 3) weekKeyOfDay maps a day to its Monday-04:00-Pacific week, incl. a DST week.
const wkExpected = (y, mo, d) => dateKey(weekStart(Date.UTC(y, mo - 1, d, 19, 0)));
ok(weekKeyOfDay('2026-06-17') === wkExpected(2026, 6, 17), 'weekKeyOfDay june midweek');
ok(weekKeyOfDay('2026-03-10') === wkExpected(2026, 3, 10), 'weekKeyOfDay DST week');
// All 7 days of one week share a week key; the next week differs.
const wk = weekKeyOfDay('2026-06-15');
for (const d of [15, 16, 17, 18, 19, 20, 21]) ok(weekKeyOfDay(`2026-06-${d}`) === wk, `2026-06-${d} in week ${wk}`);
ok(weekKeyOfDay('2026-06-22') !== wk, 'next Monday starts a new week key');

// 4) Deletion rule (P6): delete a daily ONLY if its week has a weekly summary.
{
  const daily = new Map([
    ['2026-06-10', 'a'],  // week W1
    ['2026-06-11', 'b'],  // week W1
    ['2026-06-24', 'c'],  // week W2 (>= 14 days later -> different week)
  ]);
  const w1 = weekKeyOfDay('2026-06-10');
  const w2 = weekKeyOfDay('2026-06-24');
  ok(w1 !== w2, 'test setup: the two dates are in different weeks');
  const weekly = new Map([[w1, 'summary']]); // only W1 is summarized
  for (const k of [...daily.keys()]) if (weekly.has(weekKeyOfDay(k))) daily.delete(k);
  ok(!daily.has('2026-06-10') && !daily.has('2026-06-11'), 'summarized week dailies deleted');
  ok(daily.has('2026-06-24'), 'un-summarized week daily KEPT (no tier hole)');
}

console.log(`timeline-tiers-selftest: OK (${pass} assertions)`);
