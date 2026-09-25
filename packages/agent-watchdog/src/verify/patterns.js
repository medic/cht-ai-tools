'use strict';
// Patterns the gate applies to every string the model wrote (FR-016, FR-045). The exact regexes live here.
const SECRET_PATTERNS = [
  { name: 'slack_token', pattern: /xox[abp]-[A-Za-z0-9-]+/ },
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]+/ },
  { name: 'grafana_token', pattern: /glsa_[A-Za-z0-9_]+/ },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Digits with phone-style separators; a match counts only when it holds nine or more digits.
const PHONE_PATTERN = /(?<!\w)\+?\d[\d\s().-]{7,}\d(?!\w)/g;
const PHONE_MIN_DIGITS = 9;
// Digits, one decimal point, digits: a computed value, whatever its length. A bare run of digits is not
// exempt, because that is also what an unformatted phone number looks like.
// A signed decimal (`+0.2748442279996993`) is a computed change, not a phone number (revision 24).
const DECIMAL_PATTERN = /^[+-]?\d+\.\d+$/;
// A date, or a date with a time after it: the separators are the phone pattern's own, but no phone number begins
// with a four-digit year and a month (revision 19).
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[\s.T-]\d{1,2}(?::\d{2}){0,2})?$/;

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

// Host-like tokens in prose; see isProjectLikeHost for the two-dots-or-known-suffix rule.
const HOST_LIKE_PATTERN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const KNOWN_HOST_SUFFIXES = new Set([
  'org', 'com', 'net', 'io', 'app', 'dev', 'health', 'africa', 'int', 'edu', 'gov', 'ke', 'ug', 'tz', 'ml', 'ne',
  'np', 'bd', 'in', 'uk', 'mw', 'zm', 'et', 'ng', 'sn',
]);

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isProjectLikeHost = (token) => {
  const lower = token.toLowerCase();
  const dots = (lower.match(/\./g) || []).length;
  const suffix = lower.slice(lower.lastIndexOf('.') + 1);
  return dots >= 2 || KNOWN_HOST_SUFFIXES.has(suffix);
};

const countDigits = (text) => (text.match(/\d/g) || []).length;

/**
 * Phone-like matches in a text that hold enough digits and do not sit inside a token that also carries letters: a
 * CHT version string such as `5.2.0-10700-photo-capture.29102352761-1783696221314` is an identifier, not a number.
 */
const phoneMatches = (text) => {
  const out = [];
  for (const match of String(text).matchAll(PHONE_PATTERN)) {
    if (countDigits(match[0]) < PHONE_MIN_DIGITS) {
      continue;
    }
    // A decimal is a computed value, not a phone number: an unrounded trailing mean such as
    // `26.263157894736842` has one decimal point and more digits than any phone number (revision 18).
    if (DECIMAL_PATTERN.test(match[0]) || DATE_PATTERN.test(match[0].trim())) {
      continue;
    }
    // Two decimals side by side ("0.00465 (0.01858") span the pattern; a run made only of decimal numbers and dates
    // is a list of values, not a phone number (revision 23).
    const parts = match[0].trim().split(/[\s()]+/).filter(Boolean);
    if (parts.length > 1 && parts.every((part) => DECIMAL_PATTERN.test(part) || DATE_PATTERN.test(part))) {
      continue;
    }
    let start = match.index;
    let end = match.index + match[0].length;
    while (start > 0 && /[^\s"',;|<>[\]{}]/.test(text[start - 1])) {
      start -= 1;
    }
    while (end < text.length && /[^\s"',;|<>[\]{}]/.test(text[end])) {
      end += 1;
    }
    if (!/[A-Za-z]/.test(text.slice(start, end))) {
      out.push(match[0]);
    }
  }
  return out;
};

const MONTH_NAME = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?'
  + '|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_PHRASE_PATTERN = new RegExp(
  `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME}\\b\\.?(?:,?\\s+\\d{4})?`
  + `|\\b${MONTH_NAME}\\b\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?!\\s*[:%])(?:,?\\s+\\d{4})?`,
  'gi',
);

/**
 * A day-month or month-day phrase ("15 September", "Sept 16th", "October 1, 2026") is a date the date check reads,
 * not a numeral the number check should count (revision 36); "may" is a month only when written as a name.
 */
const stripDatePhrases = (text) => String(text || '').replace(DATE_PHRASE_PATTERN, (phrase) => (
  /^may\b/.test(phrase) ? phrase : ' '
));

module.exports = {
  stripDatePhrases,
  SECRET_PATTERNS,
  EMAIL_PATTERN,
  PHONE_PATTERN,
  PHONE_MIN_DIGITS,
  DECIMAL_PATTERN,
  DATE_PATTERN,
  URL_PATTERN,
  HOST_LIKE_PATTERN,
  KNOWN_HOST_SUFFIXES,
  TIMESTAMP_PATTERN,
  isProjectLikeHost,
  countDigits,
  phoneMatches,
};
