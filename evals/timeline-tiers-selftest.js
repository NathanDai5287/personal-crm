'use strict';
// evals/timeline-tiers-selftest.js — prove the Timeline's week → month tiering rules
// behave, across DST. No model, no DB, no network, no cost. Same discipline as
// evals/selftest.js.
//
//   node evals/timeline-tiers-selftest.js
//
// Guards:
//   P6 — a LEGACY daily is deleted ONLY when its week has a weekly summary (no tier hole
//        while old profiles drain their day lines).
//   Week keys — weekKeyOfDay / weekStartOfKey agree on the Monday-04:00-Pacific week,
//        including a DST week.
//   Month fold — a month folds only once it is strictly before the cutoff month, only
//        once, and a week belongs to the month of its Monday.
//   Era supersession — a legacy season note is dropped only when every month of that
//        season that has weekly lines has its month note; a season with no weekly lines
//        keeps its note.

const assert = require('node:assert');
const {
  weekKeyOfDay, weekStartOfKey, monthKeyOfWeek, monthName, foldableMonths, dropSupersededEras, STYLE_INSTRUCTION,
} = require('../scripts/crm-timeline');
const { fmtLocal, dateKey, weekStart } = require('../lib/weeks');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass += 1; };

// 1) weekKeyOfDay maps a day to its Monday-04:00-Pacific week, incl. a DST week.
const wkExpected = (y, mo, d) => dateKey(weekStart(Date.UTC(y, mo - 1, d, 19, 0)));
ok(weekKeyOfDay('2026-06-17') === wkExpected(2026, 6, 17), 'weekKeyOfDay june midweek');
ok(weekKeyOfDay('2026-03-10') === wkExpected(2026, 3, 10), 'weekKeyOfDay DST week');
// All 7 days of one week share a week key; the next week differs.
const wk = weekKeyOfDay('2026-06-15');
for (const d of [15, 16, 17, 18, 19, 20, 21]) ok(weekKeyOfDay(`2026-06-${d}`) === wk, `2026-06-${d} in week ${wk}`);
ok(weekKeyOfDay('2026-06-22') !== wk, 'next Monday starts a new week key');

// 2) weekStartOfKey is the inverse: a week key maps back to that Monday at 04:00
//    Pacific, and re-keys to itself — also across both 2026 DST transitions.
for (const k of ['2026-06-15', '2026-03-09', '2026-11-02', wkExpected(2026, 3, 10), wkExpected(2026, 11, 3)]) {
  const ws = weekStartOfKey(k);
  ok(fmtLocal(ws).endsWith(' 04:00'), `${k}: week start ${fmtLocal(ws)} is 04:00 Pacific`);
  ok(dateKey(ws) === k, `${k}: weekStartOfKey round-trips (got ${dateKey(ws)})`);
}

// 3) Deletion rule (P6): delete a legacy daily ONLY if its week has a weekly summary.
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

// 4) Month keys and names. A week belongs to the month of its MONDAY: the week of
//    Mon 2026-06-29 (running into July) is a June week.
ok(monthKeyOfWeek('2026-06-29') === '2026-06', 'straddling week belongs to its Monday month');
ok(monthKeyOfWeek('2026-07-06') === '2026-07', 'july week');
ok(monthName('2026-07') === 'July 2026', 'monthName');
ok(monthName('2025-12') === 'December 2025', 'monthName december');

// 5) foldableMonths: only months strictly before the cutoff, only months with weekly
//    lines, never a month that already has its note; oldest first.
{
  const weekly = ['2026-05-04', '2026-05-25', '2026-06-01', '2026-06-29', '2026-07-06', '2026-07-13'];
  ok(JSON.stringify(foldableMonths(weekly, new Map(), '2026-07')) === '["2026-05","2026-06"]',
    'months before the cutoff fold, oldest first; the cutoff month waits');
  ok(JSON.stringify(foldableMonths(weekly, new Map([['2026-05', 'done']]), '2026-07')) === '["2026-06"]',
    'a month with a note never folds again');
  ok(foldableMonths(weekly, new Map(), '2026-05').length === 0, 'nothing folds before the cutoff reaches it');
  ok(foldableMonths([], new Map(), '2026-07').length === 0, 'a month with no weekly lines never folds');
}

// 6) Era supersession: drop a season note only when every month of the season with
//    weekly lines has a month note. Summer = Jun–Aug; spring = Jan–May.
{
  const weekly = ['2026-06-01', '2026-07-06', '2026-08-03'];
  const older = new Map([['2026-summer', 'summer note'], ['2025-spring', 'spring note'], ['curated', 'x']]);
  dropSupersededEras(older, weekly, new Map([['2026-06', 'j'], ['2026-07', 'k']]));
  ok(older.has('2026-summer'), 'summer kept while August has no month note');
  dropSupersededEras(older, weekly, new Map([['2026-06', 'j'], ['2026-07', 'k'], ['2026-08', 'l']]));
  ok(!older.has('2026-summer'), 'summer dropped once all three months have notes');
  ok(older.has('2025-spring'), 'a season with no weekly lines keeps its era note (only record)');
  ok(older.has('curated'), 'non-season Older entries are never touched');
}

// 7) The retired styles are gone; weekly and monthly exist.
ok(!('daily' in STYLE_INSTRUCTION) && !('era' in STYLE_INSTRUCTION), 'daily/era styles retired');
ok(typeof STYLE_INSTRUCTION.weekly === 'string' && typeof STYLE_INSTRUCTION.monthly === 'string', 'weekly+monthly styles present');
ok(!/PENDING/.test(STYLE_INSTRUCTION.monthly), 'monthly style is real text, not a placeholder');

console.log(`timeline-tiers-selftest: OK (${pass} assertions)`);
