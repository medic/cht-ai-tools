'use strict';
// Every date the model writes falls within the run's windows (FR-016, revision 33): ISO dates and day-month forms in a
// finding's prose and evidence notes, and in a brief's headline, bullets and expected-load notice. A date the run gave
// the model (`givenText`, an item's own entry) is exempt. The former check on evidence `start`/`end` fields is gone:
// the findings schema never admitted them. The dashboard range code built is still held to the same span.
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
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
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

/** A day and month without a year take the year that places them at or before the span's end. */
const resolveDayMonth = (day, monthName, year, spanEnd) => {
  const month = MONTHS[monthName.toLowerCase()];
  if (!month) {
    return null;
  }
  if (year) {
    return utcDate(Number(year), month, day);
  }
  const endYear = Number(dayOf(spanEnd).slice(0, 4));
  const sameYear = utcDate(endYear, month, day);
  if (sameYear && sameYear <= dayOf(spanEnd)) {
    return sameYear;
  }
  return utcDate(endYear - 1, month, day);
};

/** Every date written in a text, as ISO days; "may" is a month only when written as a name. */
const datesIn = (text, spanEnd) => {
  const source = String(text || '');
  const found = [];
  for (const match of source.matchAll(ISO_DATE)) {
    const iso = utcDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) {
      found.push(iso);
    }
  }
  for (const match of source.matchAll(DAY_MONTH)) {
    if (match[2].toLowerCase() === 'may' && match[2] !== 'May') {
      continue;
    }
    const iso = resolveDayMonth(Number(match[1]), match[2], match[3], spanEnd);
    if (iso) {
      found.push(iso);
    }
  }
  for (const match of source.matchAll(MONTH_DAY)) {
    if (match[1].toLowerCase() === 'may' && match[1] !== 'May') {
      continue;
    }
    const iso = resolveDayMonth(Number(match[2]), match[1], match[3], spanEnd);
    if (iso) {
      found.push(iso);
    }
  }
  return found;
};

const spanOf = (windows) => ({
  start: new Date(Math.min(...windows.map((w) => ms(w.start)))).toISOString(),
  end: new Date(Math.max(...windows.map((w) => ms(w.end)))).toISOString(),
});

/** The brief's span: its windows when given, else the run's window bounds from the discovery's run start. */
const briefSpan = (ctx) => {
  if ((ctx.windows || []).length) {
    return spanOf(ctx.windows);
  }
  const runStart = ctx.discovery && ctx.discovery.run_start;
  if (!runStart || Number.isNaN(ms(runStart))) {
    return null;
  }
  const bounds = windowBounds(new Date(runStart));
  return spanOf(bounds.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })));
};

const givenDates = (ctx, span) => {
  const texts = [...(ctx.givenText || [])];
  if (ctx.itemTexts && typeof ctx.itemTexts.values === 'function') {
    texts.push(...ctx.itemTexts.values());
  }
  return new Set(texts.flatMap((text) => datesIn(text, span.end)));
};

const dateReasons = (where, text, span, given) => {
  const reasons = [];
  for (const iso of new Set(datesIn(text, span.end))) {
    if (given.has(iso) || (iso >= dayOf(span.start) && iso <= dayOf(span.end))) {
      continue;
    }
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

module.exports = { name: NAME, check, datesIn };
