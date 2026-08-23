'use strict';
// Turn a loosely-typed due date into an ISO YYYY-MM-DD. Accepts what a person
// would actually type in a hurry: "eod"/"today", "tomorrow", a weekday name
// ("mon", "monday", "next fri"), a relative span ("in 3 days", "2w"), a
// month-day ("aug 15", "8/15"), or an ISO date already. Returns null for empty
// input, and the trimmed original if nothing matches — so a value is never
// silently dropped.
//
// `now` is injected (a Date) so the result is deterministic and testable; the
// caller passes `new Date()`.
//
// PACIFIC, not host-local. "today"/"tomorrow"/a weekday name must resolve against
// Nathan's Pacific wall-clock, not the server's clock (minmus runs UTC), or a
// task typed at 11pm Pacific would land on tomorrow's date. We take the Pacific
// calendar date of `now` (via lib/weeks.dateKey) and do every bit of the date
// arithmetic in UTC space — getUTC*/setUTCDate/Date.UTC — so the host time zone
// never enters into it. Date-only throughout; there is no time-of-day to shift.

const { dateKey } = require('./weeks');

const pad = (n) => String(n).padStart(2, '0');
// A UTC-midnight Date whose Y/M/D is the PACIFIC calendar date of `now`. All
// helpers below read/write it with getUTC*/setUTCDate so no local offset applies.
const pacificDay = (now) => {
  const [y, mo, d] = dateKey(now.getTime()).split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d));
};
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// Days until the given weekday. A bare weekday name means the upcoming one, with
// today counting as today (delta 0); "next <day>" forces the following week.
function onWeekday(today, target, forceNext) {
  let delta = (target - today.getUTCDay() + 7) % 7;
  if (forceNext) delta += 7;
  return addDays(today, delta);
}

// A month/day with the year that keeps it in the future: this year, or next year
// if that date already passed.
function onMonthDay(today, monthIdx, day) {
  let d = new Date(Date.UTC(today.getUTCFullYear(), monthIdx, day));
  if (d < today) d = new Date(Date.UTC(today.getUTCFullYear() + 1, monthIdx, day));
  return d;
}

function parseDeadline(input, now) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;
  const s = raw.toLowerCase();
  // Everything below computes against the Pacific calendar date of `now`.
  const today = pacificDay(now);

  // Already an ISO date (maybe with a trailing time) — take the date part.
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  if (s === 'today' || s === 'eod' || s === 'tonight' || s === 'now') return iso(today);
  if (s === 'tomorrow' || s === 'tmr' || s === 'tmrw' || s === 'tom') return iso(addDays(today, 1));
  if (s === 'yesterday') return iso(addDays(today, -1));
  if (s === 'next week') return iso(addDays(today, 7));
  if (s === 'eow' || s === 'end of week') return iso(onWeekday(today, 5, false));

  // "in 3 days" / "3 days" / "3d" / "in 2 weeks" / "2w"
  let m = s.match(/^(?:in\s+)?(\d+)\s*(d|days?|w|weeks?)$/);
  if (m) return iso(addDays(today, Number(m[1]) * (m[2][0] === 'w' ? 7 : 1)));

  // weekday name, optionally "next"
  m = s.match(/^(next\s+)?([a-z]+)$/);
  if (m && Object.prototype.hasOwnProperty.call(WEEKDAYS, m[2])) {
    return iso(onWeekday(today, WEEKDAYS[m[2]], Boolean(m[1])));
  }

  // "aug 15" / "august 15th"
  m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m && Object.prototype.hasOwnProperty.call(MONTHS, m[1])) {
    return iso(onMonthDay(today, MONTHS[m[1]], Number(m[2])));
  }
  // "15 aug" / "15th august"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?$/);
  if (m && Object.prototype.hasOwnProperty.call(MONTHS, m[2])) {
    return iso(onMonthDay(today, MONTHS[m[2]], Number(m[1])));
  }
  // "8/15" (month/day)
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return iso(onMonthDay(today, Number(m[1]) - 1, Number(m[2])));

  // Nothing matched — keep the original so the input is never lost.
  return raw;
}

module.exports = { parseDeadline };
