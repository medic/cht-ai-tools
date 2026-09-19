'use strict';
// The display formatter fixed in code (data-model.md "Number matching"): the same function renders values
// in the brief and decides whether a number the model wrote matches computed data.

const CODE_SPAN_PATTERN = /`([^`]*)`/g;
const DATE_LIKE_PATTERN = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g;
const TIME_LIKE_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const NUMBER_TOKEN_PATTERN = /(?<![\w.])[+-]?\d[\d,]*(?:\.\d+)?(?:%|h|d|x)?(?!\w|\.\d)/g;

const DAY_SECONDS = 86400;
const HOUR_SECONDS = 3600;

const toSignificant = (value, digits = 3) => {
  const rounded = Number(Number(value).toPrecision(digits));
  return Number.isInteger(rounded) ? rounded.toLocaleString('en-US') : String(rounded);
};

const isNil = (value) => value === null || value === undefined;

/**
 * Render a value for display.
 * Integers get thousands separators; other numbers three significant figures; `percent` or `%` one decimal and
 * a percent sign; `s` durations become `Nh` at or above an hour and `Nd` at or above a day.
 */
const formatValue = (value, unit) => {
  if (isNil(value) || Number.isNaN(Number(value))) {
    return '';
  }
  const n = Number(value);
  const u = String(unit || '').toLowerCase();
  if (u === 'percent' || u === '%') {
    return `${n.toFixed(1)}%`;
  }
  if (u === 'h' || u === 'hour' || u === 'hours') {
    return `${Math.round(n)}h`;
  }
  if (u === 'd' || u === 'day' || u === 'days') {
    return `${Math.round(n)}d`;
  }
  if (u === 's' || u === 'second' || u === 'seconds') {
    if (Math.abs(n) >= DAY_SECONDS) {
      return `${Math.round(n / DAY_SECONDS)}d`;
    }
    if (Math.abs(n) >= HOUR_SECONDS) {
      return `${Math.round(n / HOUR_SECONDS)}h`;
    }
  }
  if (Number.isInteger(n)) {
    return n.toLocaleString('en-US');
  }
  return toSignificant(n, 3);
};

/** Contents of every backtick code span in the text. */
const codeSpans = (text) => [...String(text || '').matchAll(CODE_SPAN_PATTERN)].map((m) => m[1]);

/** Strip code spans, dates and clock times so that only prose numbers remain. */
const proseOnly = (text) => String(text || '')
  .replace(CODE_SPAN_PATTERN, ' ')
  .replace(DATE_LIKE_PATTERN, ' ')
  .replace(TIME_LIKE_PATTERN, ' ');

/** Numeric tokens in prose: integers with separators, decimals, percentages, hours, days and ratios. */
const extractNumbers = (text) => [...proseOnly(text).matchAll(NUMBER_TOKEN_PATTERN)].map((m) => m[0]);

/** Parse a token produced by extractNumbers into its numeric value, suffix and decimal precision. */
const parseToken = (token) => {
  const suffixMatch = /[%hdx]$/.exec(token);
  const suffix = suffixMatch ? suffixMatch[0] : '';
  const bare = token.replace(/,/g, '').replace(/[%hdx]$/, '');
  const decimals = bare.includes('.') ? bare.split('.')[1].length : 0;
  return { numeric: Number(bare), suffix, decimals };
};

module.exports = {
  formatValue, extractNumbers, codeSpans, proseOnly, parseToken, toSignificant, HOUR_SECONDS, DAY_SECONDS,
};
