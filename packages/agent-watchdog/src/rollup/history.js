'use strict';
// Item persistence across analysed dates (data-model.md Item.persisting_days, FR-009 revision 21).
// The streak is counted in dates because the brief publishes it to a person as days; how many times
// an operator re-ran a date is not something a reader should see (research.md R-26).
const { RunDir } = require('../store/run-dir');

/** A run's analysed date: the first ten characters of its id, the shape RUN_ID_PATTERN guarantees. */
const runDate = (runId) => runId.slice(0, 10);

/**
 * A run's forced re-run number; the first run of a date is 0. Read as a number, so `-f10` follows
 * `-f9` rather than sorting between `-f1` and `-f2` as it would by code point.
 */
const runSequence = (runId) => (runId.length > 10 ? Number(runId.slice(12)) : 0);

/** The n most recent run ids before `runId`, most recent first. Counted in runs, not dates. */
const previousRunIds = async (dataDir, runId, n = Infinity) => {
  const ids = await RunDir.list(dataDir);
  const index = ids.indexOf(runId);
  const before = (index === -1 ? ids.filter((id) => id < runId) : ids.slice(0, index)).reverse();
  return Number.isFinite(n) ? before.slice(0, n) : before;
};

/**
 * The run that speaks for each date, the last one of the date (revision 34; one helper for the persistence streak
 * and calibration, revision 36): a forced re-run is another attempt at the same day, not another day.
 * @param {string[]} runIds
 * @param {{ from?: string|null, to?: string|null, before?: string|null }} [bounds] inclusive `from` and `to`,
 *   exclusive `before`, as dates
 * @returns {Map<string, string>} date to run id
 */
const lastRunPerDate = (runIds, { from = null, to = null, before = null } = {}) => {
  const speaksFor = new Map();
  for (const id of runIds) {
    const own = runDate(id);
    if ((from && own < from) || (to && own > to) || (before && own >= before)) {
      continue;
    }
    const held = speaksFor.get(own);
    if (!held || runSequence(id) > runSequence(held)) {
      speaksFor.set(own, id);
    }
  }
  return speaksFor;
};

/**
 * The analysed dates strictly before `date`, most recent first, each paired with the run that speaks
 * for it: the last run of that date, because that is the run whose output was published. Forced
 * re-runs of one date therefore contribute one date, and a date with no run at all is not a date the
 * system analysed, so it neither counts nor breaks a streak.
 * @returns {Array<[string, string]>} `[date, runId]` pairs
 */
const analysedDatesBefore = (runIds, date) => [...lastRunPerDate(runIds, { before: date }).entries()]
  .sort(([a], [b]) => b.localeCompare(a));

/**
 * Consecutive immediately preceding analysed dates whose ranked items contained each id, by item id;
 * `rankItems` adds one to reach the published `persisting_days`. A date whose authoritative run has
 * no ranked items file ends every streak.
 * @returns {Promise<Map<string, number>>}
 */
const previousItemCounts = async (dataDir, runId) => {
  const counts = new Map();
  let alive = null;
  for (const [, id] of analysedDatesBefore(await RunDir.list(dataDir), runDate(runId))) {
    const run = RunDir.open(dataDir, id);
    if (!run.exists('rollup/items.ranked.json')) {
      break;
    }
    const ranked = await run.readJson('rollup/items.ranked.json');
    const ids = new Set(ranked.map((item) => item.item_id));
    alive = alive === null ? ids : new Set([...alive].filter((itemId) => ids.has(itemId)));
    if (alive.size === 0) {
      break;
    }
    for (const itemId of alive) {
      counts.set(itemId, (counts.get(itemId) || 0) + 1);
    }
  }
  return counts;
};

module.exports = { previousItemCounts, previousRunIds, analysedDatesBefore, lastRunPerDate, runDate, runSequence };
