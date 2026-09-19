'use strict';
// Run outcomes appended to the knowledge corpus (FR-030): what reviewers confirmed or dismissed.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const atomic = require('../store/atomic');
const { dataPaths } = require('../store/run-dir');

const OUTCOME_VERDICTS = new Set(['confirmed', 'dismissed']);

const entriesOf = (byItem) => (byItem instanceof Map ? [...byItem.entries()] : Object.entries(byItem || {}));

const outcomesFile = (dataDir, date) => path.join(dataPaths(dataDir).corpusOutcomes, `${date}.jsonl`);

/** Append one line per confirmed or dismissed item, skipping ids already recorded for that day. */
const appendOutcomes = async ({ dataDir, date, runId, byItem }) => {
  const file = outcomesFile(dataDir, date);
  const existing = new Set((await atomic.readJsonl(file)).map((record) => record.item_id));
  let appended = 0;
  for (const [itemId, entry] of entriesOf(byItem)) {
    if (!OUTCOME_VERDICTS.has(entry.verdict) || existing.has(itemId)) {
      continue;
    }
    await atomic.appendJsonl(file, {
      date,
      run_id: runId,
      item_id: itemId,
      project_url: entry.project_url,
      metric: entry.metric,
      pattern_card: entry.pattern_card === undefined ? null : entry.pattern_card,
      outcome: entry.verdict,
      up: entry.up || 0,
      down: entry.down || 0,
      notes: entry.notes || [],
    });
    existing.add(itemId);
    appended += 1;
  }
  return { appended };
};

/** Outcomes recorded for days in the inclusive range [from, to]. */
const readOutcomes = async (dataDir, { from, to }) => {
  const dir = dataPaths(dataDir).corpusOutcomes;
  if (!fsSync.existsSync(dir)) {
    return [];
  }
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort();
  const records = [];
  for (const name of files) {
    const date = name.replace(/\.jsonl$/, '');
    if (date >= from && date <= to) {
      records.push(...await atomic.readJsonl(path.join(dir, name)));
    }
  }
  return records;
};

module.exports = { appendOutcomes, readOutcomes, OUTCOME_VERDICTS };
