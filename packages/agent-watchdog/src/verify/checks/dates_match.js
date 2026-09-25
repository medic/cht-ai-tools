'use strict';
// Every date the model writes falls within the run's windows (FR-016, revision 33), unless the run gave it that date:
// ISO dates and timestamps, and day-month forms with or without a year, in a finding's prose and evidence notes and
// in a brief's headline, bullets and expected-load notice. A day-month without a year is ambiguous (revision 36): it
// is exempt when any year's reading of it was given, and otherwise checked in the reading nearest the run. The
// texts the run gave are `givenText` (prompts and tool results), `givenDateText` (the system prompt with its window
// notes and memory, or the roll-up's feedback and memory sections) and an item's own entry.
const { sameMetric } = require('../metric-key');
const { windowBounds } = require('../../collect/windows');

const NAME = 'dates_match';

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11,
  november: 11, dec: 12, december: 12,
};
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?'
  + '|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORDINAL = '(?:st|nd|rd|th)?';
// A timestamp's `T` follows the day with no word boundary, so both forms are read (revision 36).
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?=\b|T)/g;
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+(\\d{4}))?`, 'gi');
const MONTH_DAY = new RegExp(`\\b${MONTH}\\b\\.?\\s+(\\d{1,2})${ORDINAL}\\b(?!\\s*[:%])(?:,?\\s+(\\d{4}))?`, 'gi');

const ms = (t) => Date.parse(t);

const within = (start, end, span) => ms(start) >= ms(span.start) && ms(end) <= ms(span.end) && ms(start) < ms(end);

const dayOf = (iso) => String(iso).slice(0, 10);

const utcDate = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date.toISOString().slice(0, 10) : null;
};

/**
 * The readings of a day and month: one when a year is written, else the three years around the span's end, so a
 * date the model restates from a horizon ("1 October") is read as the run read it (revision 36).
 */
const readingsOf = (day, monthName, year, spanEnd) => {
  const month = MONTHS[monthName.toLowerCase()];
  if (!month) {
    return [];
  }
  if (year) {
    return [utcDate(Number(year), month, day)].filter(Boolean);
  }
  const endYear = Number(dayOf(spanEnd).slice(0, 4));
  return [endYear - 1, endYear, endYear + 1].map((y) => utcDate(y, month, day)).filter(Boolean);
};

/** Every date written in a text, each as its readings (ISO days); "may" is a month only when written as a name. */
const datesIn = (text, spanEnd) => {
  const source = String(text || '');
  const found = [];
  for (const match of source.matchAll(ISO_DATE)) {
    const iso = utcDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) {
      found.push({ written: match[0], readings: [iso] });
    }
  }
  for (const match of source.matchAll(DAY_MONTH)) {
    if (match[2].toLowerCase() === 'may' && match[2] !== 'May') {
      continue;
    }
    const readings = readingsOf(Number(match[1]), match[2], match[3], spanEnd);
    if (readings.length) {
      found.push({ written: match[0], readings });
    }
  }
  for (const match of source.matchAll(MONTH_DAY)) {
    if (match[1].toLowerCase() === 'may' && match[1] !== 'May') {
      continue;
    }
    const readings = readingsOf(Number(match[2]), match[1], match[3], spanEnd);
    if (readings.length) {
      found.push({ written: match[0], readings });
    }
  }
  return found;
};

const spanOf = (windows) => ({
  start: new Date(Math.min(...windows.map((w) => ms(w.start)))).toISOString(),
  end: new Date(Math.max(...windows.map((w) => ms(w.end)))).toISOString(),
});

/**
 * The brief's span: its windows when given, else the run's window bounds from the discovery's run start, with the
 * previous cycle when an expected-load window with one is active (revision 36).
 */
const briefSpan = (ctx) => {
  if ((ctx.windows || []).length) {
    return spanOf(ctx.windows);
  }
  const runStart = ctx.discovery && ctx.discovery.run_start;
  if (!runStart || Number.isNaN(ms(runStart))) {
    return null;
  }
  const bounds = windowBounds(new Date(runStart), { activeWindow: ctx.activeWindow || null });
  return spanOf(bounds.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })));
};

/** Every reading of every date in the texts the run gave the model. */
const givenDates = (ctx, span) => {
  const texts = [...(ctx.givenText || []), ...(ctx.givenDateText || [])];
  if (ctx.itemTexts && typeof ctx.itemTexts.values === 'function') {
    texts.push(...ctx.itemTexts.values());
  }
  return new Set(texts.flatMap((text) => datesIn(text, span.end)).flatMap((entry) => entry.readings));
};

const inside = (iso, span) => iso >= dayOf(span.start) && iso <= dayOf(span.end);

/** The reading nearest the span: inside it when one is, else the least distance from either end. */
const nearestReading = (readings, span) => {
  const distance = (iso) => {
    if (inside(iso, span)) {
      return 0;
    }
    return Math.min(Math.abs(ms(iso) - ms(span.start)), Math.abs(ms(iso) - ms(span.end)));
  };
  return [...readings].sort((a, b) => distance(a) - distance(b))[0];
};

const dateReasons = (where, text, span, given) => {
  const reasons = [];
  const seen = new Set();
  for (const entry of datesIn(text, span.end)) {
    if (entry.readings.some((iso) => given.has(iso))) {
      continue;
    }
    const iso = nearestReading(entry.readings, span);
    if (inside(iso, span) || seen.has(iso)) {
      continue;
    }
    seen.add(iso);
    reasons.push(`${where} names ${iso}, outside the run's windows (${dayOf(span.start)} to ${dayOf(span.end)})`);
  }
  return reasons;
};

const checkBrief = (ctx) => {
  const span = briefSpan(ctx);
  if (!span) {
    return { name: NAME, status: 'pass', reasons: ['no run start to check dates against'] };
  }
  const given = givenDates(ctx, span);
  const reasons = [...dateReasons('headline', ctx.draft.headline, span, given)];
  (ctx.draft.bullets || []).forEach((bullet, i) => {
    reasons.push(...dateReasons(`bullets[${i}]`, bullet.text, span, given));
  });
  if (ctx.draft.expected_load_notice) {
    reasons.push(...dateReasons('expected_load_notice', ctx.draft.expected_load_notice, span, given));
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

const check = (ctx) => {
  if (ctx.mode === 'brief') {
    return checkBrief(ctx);
  }
  const reasons = [];
  (ctx.items || []).forEach((item, i) => {
    const windows = (ctx.windows || [])
      .filter((w) => w.project_url === item.project_url && sameMetric(w.metric, item.metric));
    if (windows.length === 0) {
      reasons.push(`items[${i}] metric ${item.metric} has no collected windows`);
      return;
    }
    const span = spanOf(windows);
    const given = givenDates(ctx, span);
    reasons.push(...dateReasons(`items[${i}].why_now`, item.why_now, span, given));
    reasons.push(...dateReasons(`items[${i}].suggested_check`, item.suggested_check, span, given));
    (item.evidence || []).forEach((evidence, j) => {
      if (evidence && evidence.note) {
        reasons.push(...dateReasons(`items[${i}].evidence[${j}].note`, evidence.note, span, given));
      }
    });
    const ref = item.dashboard_ref || {};
    if (!ref.from || !ref.to || !within(ref.from, ref.to, span)) {
      reasons.push(`items[${i}].dashboard_ref ${ref.from} to ${ref.to} is outside the run's windows`);
    }
  });
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };
