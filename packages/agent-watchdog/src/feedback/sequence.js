'use strict';
// The notes on one item are one conversation (FR-085, revision 29): read in thread order, the last note that
// states a horizon sets the horizon applied and the last that states an expected maximum sets that; every author
// counts once. Code decides this; the model only reads a dateless note with the earlier notes as context.
const identity = require('../model/identity');

const runDateOf = (record) => {
  try {
    return identity.parseRunId(String(record.run_id || '')).date || '';
  } catch {
    return String(record.run_id || '');
  }
};

/** A Slack ts ("1758090000.000002") as [seconds, fraction] so two notes a microsecond apart still compare. */
const tsParts = (record) => {
  const [seconds, fraction = ''] = String(record.source_ts || '').split('.');
  return [Number(seconds) || 0, fraction.padEnd(6, '0')];
};

const compareThread = (a, b) => {
  const da = runDateOf(a);
  const db = runDateOf(b);
  if (da !== db) {
    return da < db ? -1 : 1;
  }
  const [sa, fa] = tsParts(a);
  const [sb, fb] = tsParts(b);
  if (sa !== sb) {
    return sa - sb;
  }
  if (fa === fb) {
    return 0;
  }
  return fa < fb ? -1 : 1;
};

/** Records in thread order: the date of the run whose post they sit under, then their Slack timestamp. */
const threadOrder = (records) => [...records].sort(compareThread);

/**
 * The clarified whole of one item's notes, given in thread order: the last stated horizon and expected maximum,
 * the note that set the horizon, and the number of people who wrote.
 * @param {Array<{ note?: string, text?: string, horizon?: string|null, expected_max?: number|null,
 *   author?: string }>} notes
 */
const clarifiedWhole = (notes) => {
  let horizon = null;
  let expectedMax = null;
  let note = null;
  const authors = new Set();
  for (const entry of notes) {
    if (entry.author) {
      authors.add(entry.author);
    }
    if (entry.horizon) {
      horizon = entry.horizon;
      const written = entry.note === undefined || entry.note === null ? entry.text : entry.note;
      note = written === undefined ? null : written;
    }
    if (entry.expected_max !== undefined && entry.expected_max !== null) {
      expectedMax = entry.expected_max;
    }
  }
  return { horizon, expected_max: expectedMax, note, author_count: authors.size, notes: notes.length };
};

module.exports = { threadOrder, clarifiedWhole, compareThread };
