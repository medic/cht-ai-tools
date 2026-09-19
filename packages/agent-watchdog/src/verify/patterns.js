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

module.exports = {
  SECRET_PATTERNS,
  EMAIL_PATTERN,
  PHONE_PATTERN,
  PHONE_MIN_DIGITS,
  URL_PATTERN,
  HOST_LIKE_PATTERN,
  KNOWN_HOST_SUFFIXES,
  TIMESTAMP_PATTERN,
  isProjectLikeHost,
  countDigits,
};
