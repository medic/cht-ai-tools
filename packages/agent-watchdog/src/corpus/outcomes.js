'use strict';
// Run outcomes appended to the knowledge corpus (FR-030): what reviewers confirmed or dismissed.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const atomic = require('../store/atomic');
const { dataPaths } = require('../store/run-dir');
const { maskNote } = require('./scrub');

const OUTCOME_VERDICTS = new Set(['confirmed', 'dismissed']);

const entriesOf = (byItem) => (byItem instanceof Map ? [...byItem.entries()] : Object.entries(byItem || {}));

const outcomesFile = (dataDir, date) => path.join(dataPaths(dataDir).corpusOutcomes, `${date}.jsonl`);

/**
 * Append one line per confirmed or dismissed item, skipping ids already recorded for that day. With `itemIds`
 * (revision 34) only those items are considered: the run passes the items whose feedback it read anew, so a
 * verdict standing since last week is not appended again every day of the influence window.
 */
const appendOutcomes = async ({ dataDir, date, runId, byItem, itemIds = null }) => {
  const file = outcomesFile(dataDir, date);
  const existing = new Set((await atomic.readJsonl(file)).map((record) => record.item_id));
  const wanted = itemIds === null || itemIds === undefined ? null : new Set(itemIds);
  let appended = 0;
  for (const [itemId, entry] of entriesOf(byItem)) {
    if (!OUTCOME_VERDICTS.has(entry.verdict) || existing.has(itemId) || (wanted && !wanted.has(itemId))) {
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
      // Notes masked of people, addresses and phones (revision 36): the corpus feeds distillation prompts.
      notes: (entry.notes || []).map(maskNote),
    });
    existing.add(itemId);
    appended += 1;
  }
  return { appended };
};

const ALERT_EPISODE_KIND = 'alert_episode';
const isAlertEpisode = (record) => record && record.kind === ALERT_EPISODE_KIND;

/**
 * Append cleared alert episodes (FR-067) beside the day's item outcomes, once per episode id. They carry
 * `kind: alert_episode` so item-outcome readers (calibration) never count them.
 */
const appendAlertEpisodes = async ({ dataDir, date, runId, episodes }) => {
  const file = outcomesFile(dataDir, date);
  const existing = new Set((await atomic.readJsonl(file)).filter(isAlertEpisode).map((record) => record.episode_id));
  let appended = 0;
  for (const episode of episodes || []) {
    if (existing.has(episode.episode_id)) {
      continue;
    }
    const { event, run_id: sourceRun, at, ...fields } = episode;
    void event;
    void sourceRun;
    void at;
    await atomic.appendJsonl(file, { kind: ALERT_EPISODE_KIND, date, run_id: runId, ...fields });
    existing.add(episode.episode_id);
    appended += 1;
  }
  return { appended };
};

const readOutcomeRecords = async (dataDir, { from, to }) => {
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

/** Item outcomes recorded for days in the inclusive range [from, to]; alert episodes are left out. */
const readOutcomes = async (dataDir, range) => (await readOutcomeRecords(dataDir, range))
  .filter((record) => !isAlertEpisode(record));


module.exports = {
  appendOutcomes, readOutcomes, appendAlertEpisodes, OUTCOME_VERDICTS, ALERT_EPISODE_KIND,
};
