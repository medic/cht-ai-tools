'use strict';
// The display formatter fixed in code (data-model.md "Number matching"): the same function renders values
// in the brief and decides whether a number the model wrote matches computed data.

const CODE_SPAN_PATTERN = /`([^`]*)`/g;
const DATE_LIKE_PATTERN = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g;
const TIME_LIKE_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const NUMBER_TOKEN_PATTERN = /(?<![\w.])[+-]?\d[\d,]*(?:\.\d+)?(?:%|h|d|x)?(?!\w|\.\d)/g;
// A comma joins digits into one numeral only as a thousands separator: groups of three after a first group of one to
// three digits (revision 25). `1789538400,390778880` in a JSON pair is two numbers, not one the model never saw.
const THOUSANDS_GROUPED_PATTERN = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:%|h|d|x)?$/;
// A unit written as a word after a numeral carries the unit as the letter suffixes do: "7.5 days" is `7.5d`.
const UNIT_WORD_PATTERN = /^\s+(days?|hours?)\b/;

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

/** A matched token as the numerals it holds: one when its commas group thousands, otherwise one per comma-part. */
const splitJoined = (rawToken) => {
  const token = rawToken.replace(/,+$/, '');
  if (!token.includes(',') || THOUSANDS_GROUPED_PATTERN.test(token)) {
    return [token];
  }
  return token.split(',').filter((part) => /\d/.test(part));
};

const tokensIn = (text, { unitWords = false } = {}) => {
  const out = [];
  for (const match of text.matchAll(NUMBER_TOKEN_PATTERN)) {
    const parts = splitJoined(match[0]);
    if (unitWords && parts.length === 1 && !/[%hdx]$/.test(parts[0])) {
      const word = UNIT_WORD_PATTERN.exec(text.slice(match.index + match[0].length));
      if (word) {
        parts[0] += word[1].startsWith('day') ? 'd' : 'h';
      }
    }
    out.push(...parts);
  }
  return out;
};

/**
 * Numeric tokens in prose: integers with separators, decimals, percentages, hours, days and ratios; a unit word
 * (`days`, `hours`) after a numeral becomes its suffix (revision 25).
 */
const extractNumbers = (text) => tokensIn(proseOnly(text), { unitWords: true });

/**
 * Numeric tokens anywhere in a text the model was given (revision 23): dates and clock times dropped, code kept,
 * because a prompt's fenced JSON is exactly where its numbers live; the numbers of a JSON pair read one at a time.
 */
const extractNumbersEverywhere = (text) => tokensIn(String(text || '')
  .replace(DATE_LIKE_PATTERN, ' ')
  .replace(TIME_LIKE_PATTERN, ' '));

/** Parse a token produced by extractNumbers into its numeric value, suffix and decimal precision. */
const parseToken = (token) => {
  const suffixMatch = /[%hdx]$/.exec(token);
  const suffix = suffixMatch ? suffixMatch[0] : '';
  const bare = token.replace(/,/g, '').replace(/[%hdx]$/, '');
  const decimals = bare.includes('.') ? bare.split('.')[1].length : 0;
  return { numeric: Number(bare), suffix, decimals };
};

module.exports = {
  formatValue, extractNumbers,
  extractNumbersEverywhere, codeSpans, proseOnly, parseToken, toSignificant, HOUR_SECONDS, DAY_SECONDS,
};
