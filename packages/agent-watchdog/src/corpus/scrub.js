'use strict';
// Identifier scrubbing for proposals and pattern cards (FR-033, FR-036). Deterministic and offline: secrets,
// addresses, project hostnames and people are replaced by placeholders in the text and listed as flags.
// Hostname and person excerpts stay visible in the flag because proposal files live on the private data volume
// and the reviewer must know what to generalise before anything reaches the public repository; secrets are
// never stored, only the name of the pattern that matched.
const {
  SECRET_PATTERNS, EMAIL_PATTERN, PHONE_PATTERN, PHONE_MIN_DIGITS, HOST_LIKE_PATTERN, isProjectLikeHost, countDigits,
} = require('../verify/patterns');

// Kinds in the order overlaps are resolved: an e-mail address wins over the hostname inside it.
const KIND_ORDER = ['secret', 'address', 'hostname', 'person'];
const PLACEHOLDER = { secret: '[secret]', address: '[address]', hostname: '[hostname]', person: '[person]' };

// Slack user ids: U plus 8 to 10 upper-case alphanumerics with at least one digit, so an upper-case word such as
// UNAVAILABLE is not mistaken for one. Mentions wrap the id as <@U…> or <@U…|name>.
const SLACK_USER_ID = /\bU(?=[A-Z0-9]{8,10}\b)[A-Z0-9]*\d[A-Z0-9]*\b/;
const SLACK_MENTION = /<@(U(?=[A-Z0-9]{8,10}\b)[A-Z0-9]*\d[A-Z0-9]*)(?:\|[^>]*)?>/g;

const globalOf = (pattern) => (pattern.flags.includes('g')
  ? pattern
  : new RegExp(pattern.source, `${pattern.flags}g`));

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const maskEmail = (email) => {
  const at = String(email).indexOf('@');
  if (at < 1) {
    return '***';
  }
  return `${email.slice(0, 1)}***${email.slice(at)}`;
};

const maskPhone = (phone) => {
  const digits = countDigits(phone);
  let seen = 0;
  return String(phone).replace(/\d/g, (digit) => {
    seen += 1;
    return seen > digits - 2 ? digit : '*';
  });
};

const spansOf = (text, pattern, kind, excerptOf, accept = () => true) => {
  const spans = [];
  for (const match of text.matchAll(globalOf(pattern))) {
    if (match[0] && accept(match)) {
      spans.push({ start: match.index, end: match.index + match[0].length, kind, excerpt: excerptOf(match) });
    }
  }
  return spans;
};

const hostPattern = (host) => new RegExp(`(?<![a-z0-9.-])${escapeRegex(host)}(?![a-z0-9-])`, 'gi');
const personPattern = (name) => new RegExp(`(?<![\\w-])${escapeRegex(name)}(?![\\w-])`, 'gi');

const candidateSpans = (text, { hosts, persons, allowedHosts }) => {
  const allowed = new Set(allowedHosts.map((h) => String(h).toLowerCase()));
  const spans = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    spans.push(...spansOf(text, pattern, 'secret', () => name));
  }
  spans.push(...spansOf(text, EMAIL_PATTERN, 'address', (m) => maskEmail(m[0])));
  const isPhone = (m) => countDigits(m[0]) >= PHONE_MIN_DIGITS;
  spans.push(...spansOf(text, PHONE_PATTERN, 'address', (m) => maskPhone(m[0]), isPhone));
  for (const host of hosts.filter(Boolean)) {
    spans.push(...spansOf(text, hostPattern(host), 'hostname', (m) => m[0]));
  }
  spans.push(...spansOf(text, HOST_LIKE_PATTERN, 'hostname', (m) => m[0], (m) => (
    isProjectLikeHost(m[0]) && !allowed.has(m[0].toLowerCase())
  )));
  spans.push(...spansOf(text, SLACK_MENTION, 'person', (m) => m[1]));
  spans.push(...spansOf(text, SLACK_USER_ID, 'person', (m) => m[0]));
  for (const person of persons.filter(Boolean)) {
    spans.push(...spansOf(text, personPattern(person), 'person', () => String(person)));
  }
  return spans;
};

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

/** Keep spans kind by kind in priority order, dropping any that overlap an already accepted span. */
const resolveOverlaps = (spans) => {
  const accepted = [];
  for (const kind of KIND_ORDER) {
    const ofKind = spans.filter((s) => s.kind === kind).sort((a, b) => a.start - b.start || b.end - a.end);
    for (const span of ofKind) {
      if (!accepted.some((other) => overlaps(other, span))) {
        accepted.push(span);
      }
    }
  }
  return accepted.sort((a, b) => a.start - b.start);
};

/**
 * @param {string} text
 * @param {object} [options]
 * @param {string[]} [options.hosts] discovered project hosts, always masked
 * @param {string[]} [options.persons] names or ids to mask wherever they appear
 * @param {string[]} [options.allowedHosts] documentation and tooling hosts that are not project identifiers
 * @returns {{ text: string, flags: Array<{ kind: string, excerpt: string }> }}
 */
const applySpans = (source, spans) => {
  let out = '';
  let cursor = 0;
  const flags = [];
  const seen = new Set();
  for (const span of spans) {
    out += source.slice(cursor, span.start) + PLACEHOLDER[span.kind];
    cursor = span.end;
    const key = `${span.kind}:${span.excerpt}`;
    if (!seen.has(key)) {
      seen.add(key);
      flags.push({ kind: span.kind, excerpt: span.excerpt });
    }
  }
  out += source.slice(cursor);
  return { text: out, flags };
};

const scrub = (text, { hosts = [], persons = [], allowedHosts = [] } = {}) => {
  const source = text === null || text === undefined ? '' : String(text);
  if (!source) {
    return { text: '', flags: [] };
  }
  return applySpans(source, resolveOverlaps(candidateSpans(source, { hosts, persons, allowedHosts })));
};

/**
 * Mask people, e-mail addresses, phone numbers and secrets, and keep every hostname: for text that stays on the data
 * volume and returns to the model, such as the memory update (FR-044, revision 33), where the projects are the subject.
 */
const maskPersonalData = (text, { persons = [] } = {}) => {
  const source = text === null || text === undefined ? '' : String(text);
  if (!source) {
    return { text: '', flags: [] };
  }
  const spans = candidateSpans(source, { hosts: [], persons, allowedHosts: [] }).filter((s) => s.kind !== 'hostname');
  return applySpans(source, resolveOverlaps(spans));
};

/** Replace Slack mentions and bare user ids with [person]; used wherever note text reaches a prompt or a post. */
const maskPeople = (text) => String(text === null || text === undefined ? '' : text)
  .replace(SLACK_MENTION, '[person]')
  .replace(new RegExp(SLACK_USER_ID.source, 'g'), '[person]');

module.exports = {
  scrub, maskPersonalData, maskEmail, maskPhone, maskPeople, SLACK_USER_ID, SLACK_MENTION, KIND_ORDER, PLACEHOLDER,
};
