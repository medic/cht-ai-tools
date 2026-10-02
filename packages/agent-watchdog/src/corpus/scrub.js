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
 * A phone number as a person writes one (FR-029, FR-044; revisions 36 and 37): a run of nine or more digits that
 * starts with a plus or a zero, whatever its grouping, or that brackets, dots or dashes group into parts of at most
 * four digits. Not a phone number: a bare run of digits (a count, a byte size, an id), a decimal, integers or
 * decimals side by side (a list of values, a range such as `150000-200000` or `1234.5-2345.6`, a value with its
 * previous one in brackets) and a date in any form, ISO or `20.09.2026`. A label glued to the number (`tel:+254…`)
 * does not hide it, and a date after it stays where it is. Memory and notes keep everything but the number.
 */
const ISO_DAY_IN = /\d{4}-\d{2}-\d{2}(?:[\sT]\d{1,2}(?::\d{2}){0,2})?/g;
const DOTTED_DAY = /^\d{1,2}\.\d{1,2}\.\d{4}$/;
const SEPARATORS = /^[\s.-]+|[\s().-]+$/g;
const phoneLike = (span) => {
  if ((span.match(/\d/g) || []).length < PHONE_MIN_DIGITS) {
    return false;
  }
  const parts = span.split(/[\s()-]+/).filter(Boolean);
  if (parts.some((part) => DOTTED_DAY.test(part) || /\d\.\d/.test(part))) {
    return false;
  }
  if (/^[+0]/.test(span)) {
    return true;
  }
  // Spaces alone group a list of values; brackets, dots or dashes group a number into short parts.
  return /[().-]/.test(span) && parts.length > 1 && parts.every((part) => part.replace(/\D/g, '').length <= 4);
};
const phoneSpans = (text) => {
  const source = String(text);
  const out = [];
  for (const match of source.matchAll(PHONE_PATTERN)) {
    // The pattern starts at a digit; a bracket before it belongs to the number when the area code closes it.
    const opened = match.index > 0 && source[match.index - 1] === '(' && match[0].includes(')');
    const raw = opened ? `(${match[0]}` : match[0];
    // A date inside the match is not part of the number: what is left on either side is read on its own.
    for (const piece of raw.split(ISO_DAY_IN)) {
      const span = piece.replace(SEPARATORS, '');
      if (span && phoneLike(span) && !out.includes(span)) {
        out.push(span);
      }
    }
  }
  return out;
};

/**
 * Mask what identifies a person and nothing else: Slack mentions and user ids, e-mail addresses, phone numbers with
 * separators, and secrets. Hostnames, numbers, dates, versions and names stay. This is the rule for text that
 * stays on the volume and returns to the model (the memory update, FR-044) and for every note that reaches a
 * prompt (FR-029), revision 36.
 * @returns {{ text: string, flags: Array<{ kind: string, excerpt: string }> }}
 */
const maskPersonalData = (text) => {
  let out = text === null || text === undefined ? '' : String(text);
  if (!out) {
    return { text: '', flags: [] };
  }
  const flags = [];
  const seen = new Set();
  const flag = (kind, excerpt) => {
    const key = `${kind}:${excerpt}`;
    if (!seen.has(key)) {
      seen.add(key);
      flags.push({ kind, excerpt });
    }
  };
  for (const { name, pattern } of SECRET_PATTERNS) {
    out = out.replace(globalOf(pattern), () => {
      flag('secret', name);
      return PLACEHOLDER.secret;
    });
  }
  out = out.replace(globalOf(EMAIL_PATTERN), (match) => {
    flag('address', maskEmail(match));
    return PLACEHOLDER.address;
  });
  for (const match of phoneSpans(out)) {
    flag('address', maskPhone(match));
    out = out.split(match).join(PLACEHOLDER.address);
  }
  out = out.replace(SLACK_MENTION, (match, id) => {
    flag('person', id);
    return PLACEHOLDER.person;
  });
  out = out.replace(new RegExp(SLACK_USER_ID.source, 'g'), (match) => {
    flag('person', match);
    return PLACEHOLDER.person;
  });
  return { text: out, flags };
};

/** The text of a note as a prompt may carry it: people, addresses and secrets masked, everything else as written. */
const maskNote = (text) => maskPersonalData(text).text;

/** Replace Slack mentions and bare user ids with [person]; used wherever note text reaches a prompt or a post. */
const maskPeople = (text) => String(text === null || text === undefined ? '' : text)
  .replace(SLACK_MENTION, '[person]')
  .replace(new RegExp(SLACK_USER_ID.source, 'g'), '[person]');

module.exports = {
  scrub, maskPersonalData, maskNote, maskEmail, maskPhone, maskPeople, SLACK_USER_ID, SLACK_MENTION, KIND_ORDER,
  PLACEHOLDER,
};
