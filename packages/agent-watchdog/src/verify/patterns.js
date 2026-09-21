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
const DECIMAL_PATTERN = /^\d+\.\d+$/;
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

module.exports = {
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
