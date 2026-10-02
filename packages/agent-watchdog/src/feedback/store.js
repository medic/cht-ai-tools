'use strict';
// feedback.jsonl: the append-only record of reactions and notes (FR-028), de-duplicated by feedback_id.
const { dataPaths } = require('../store/run-dir');
const { appendJsonl, readJsonl, writeFileAtomic } = require('../store/atomic');
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

/**
 * Rewrite every record through `updater`, validating the result before anything is written (an invalid
 * update leaves the file untouched). The file is small by design (FR-059), so a full atomic rewrite is fine.
 * @returns {Promise<number>} records whose content changed
 */
const updateRecords = async (dataDir, updater) => {
  const records = await readAll(dataDir);
  const next = records.map((record) => schemas.Feedback.parse(updater(record)));
  const changed = next.filter((record, i) => JSON.stringify(record) !== JSON.stringify(records[i])).length;
  if (changed > 0) {
    await writeFileAtomic(feedbackFile(dataDir), `${next.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  return changed;
};

/** Records no digest has acknowledged yet (FR-062). */
const readUnacknowledged = async (dataDir) => (await readAll(dataDir))
  .filter((record) => !record.acknowledged_run_id);

/** Mark records acknowledged by `runId`; a record already acknowledged keeps its first run. */
const markAcknowledged = async (dataDir, feedbackIds, runId) => {
  const wanted = new Set(feedbackIds);
  return updateRecords(dataDir, (record) => (
    wanted.has(record.feedback_id) && !record.acknowledged_run_id ? { ...record, acknowledged_run_id: runId } : record
  ));
};

module.exports = {
  appendRecords, readAll, feedbackFile, updateRecords, readUnacknowledged, markAcknowledged,
};
