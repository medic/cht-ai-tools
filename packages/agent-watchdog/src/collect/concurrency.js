'use strict';
// A bounded worker pool: `worker(item, index)` for every item, at most `limit` at a time, results in input order.
// The first rejection rejects the whole map once the workers already running have settled their current item.
const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  await Promise.all(Array.from({ length: workers }, run));
  return results;
};

module.exports = { mapWithConcurrency };
