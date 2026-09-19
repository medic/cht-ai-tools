'use strict';
// Item persistence across runs (data-model.md Item.persisting_days).
const { RunDir } = require('../store/run-dir');

/** The n most recent run ids before `runId`, most recent first. */
const previousRunIds = async (dataDir, runId, n = Infinity) => {
  const ids = await RunDir.list(dataDir);
  const index = ids.indexOf(runId);
  const before = (index === -1 ? ids.filter((id) => id < runId) : ids.slice(0, index)).reverse();
  return Number.isFinite(n) ? before.slice(0, n) : before;
};

/**
 * Consecutive immediately preceding runs whose ranked items contained each id; a run without a ranked
 * items file ends every streak.
 * @returns {Promise<Map<string, number>>}
 */
const previousItemCounts = async (dataDir, runId) => {
  const counts = new Map();
  let alive = null;
  for (const id of await previousRunIds(dataDir, runId)) {
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

module.exports = { previousItemCounts, previousRunIds };
