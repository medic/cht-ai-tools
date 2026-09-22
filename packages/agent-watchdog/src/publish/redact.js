'use strict';
// Code text that quotes something outside the gate, the failure notice's error message above all, is passed through
// the same secret and personal-data patterns the gate applies, with every match redacted (FR-024, FR-045, revision 27).
const { SECRET_PATTERNS, EMAIL_PATTERN, phoneMatches } = require('../verify/patterns');

const REDACTED = '[redacted]';

const global = (pattern) => (pattern.flags.includes('g')
  ? pattern
  : new RegExp(pattern.source, `${pattern.flags}g`));

/** The text with every secret, e-mail address and phone-shaped run replaced by `[redacted]`. */
const redactText = (text) => {
  let out = String(text === undefined || text === null ? '' : text);
  for (const { pattern } of SECRET_PATTERNS) {
    out = out.replace(global(pattern), REDACTED);
  }
  out = out.replace(global(EMAIL_PATTERN), REDACTED);
  for (const match of phoneMatches(out)) {
    out = out.split(match).join(REDACTED);
  }
  return out;
};

module.exports = { redactText, REDACTED };
