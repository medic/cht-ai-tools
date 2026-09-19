'use strict';
// feedback.jsonl: the append-only record of reactions and notes (FR-028), de-duplicated by feedback_id.
const { dataPaths } = require('../store/run-dir');
const { appendJsonl, readJsonl } = require('../store/atomic');
const { schemas } = require('../model/schemas');

const feedbackFile = (dataDir) => dataPaths(dataDir).feedbackFile;

/** Validate every record first, then append the ones whose feedback_id is not already stored. */
const appendRecords = async (dataDir, records) => {
  const parsed = records.map((record) => schemas.Feedback.parse(record));
  const file = feedbackFile(dataDir);
  const seen = new Set((await readJsonl(file)).map((record) => record.feedback_id));
  let appended = 0;
  let skipped = 0;
  for (const record of parsed) {
    if (seen.has(record.feedback_id)) {
      skipped += 1;
      continue;
    }
    await appendJsonl(file, record);
    seen.add(record.feedback_id);
    appended += 1;
  }
  return { appended, skipped };
};

const readAll = (dataDir) => readJsonl(feedbackFile(dataDir));

/** Records that target an item, grouped by item_id; brief-level records are left out. */
const readByItem = async (dataDir) => {
  const byItem = new Map();
  for (const record of await readAll(dataDir)) {
    if (record.target !== 'item' || !record.item_id) {
      continue;
    }
    if (!byItem.has(record.item_id)) {
      byItem.set(record.item_id, []);
    }
    byItem.get(record.item_id).push(record);
  }
  return byItem;
};

module.exports = { appendRecords, readAll, readByItem, feedbackFile };
