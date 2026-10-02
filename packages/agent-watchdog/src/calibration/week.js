'use strict';
// ISO-8601 weeks, the unit of the calibration report (data-model.md "Calibration Report": `week` is `YYYY-Www`).
const DAY_MS = 86400000;
const WEEK_PATTERN = /^(\d{4})-W(\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

const toDate = (value) => {
  const date = value instanceof Date
    ? value
    : new Date(typeof value === 'string' && DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`invalid date: ${value}`);
  }
  return date;
};

/** The ISO week containing a date: the week of its Thursday, numbered from the week that holds 4 January. */
const isoWeekOf = (value) => {
  const date = toDate(value);
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

/** Monday and Sunday of a week; a RangeError for a malformed week or one the year does not have. */
const weekRange = (week) => {
  const match = WEEK_PATTERN.exec(String(week));
  if (!match) {
    throw new RangeError(`week must be YYYY-Www, got ${week}`);
  }
  const year = Number(match[1]);
  const number = Number(match[2]);
  if (number < 1 || number > 53) {
    throw new RangeError(`week number must be between 01 and 53, got ${week}`);
  }
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7;
  const mondayMs = jan4.getTime() - (jan4Weekday - 1) * DAY_MS + (number - 1) * 7 * DAY_MS;
  if (isoWeekOf(new Date(mondayMs)) !== `${match[1]}-W${match[2]}`) {
    throw new RangeError(`${week} does not exist`);
  }
  return { monday: isoDate(mondayMs), sunday: isoDate(mondayMs + 6 * DAY_MS) };
};

module.exports = { isoWeekOf, weekRange, WEEK_PATTERN, DAY_MS };
