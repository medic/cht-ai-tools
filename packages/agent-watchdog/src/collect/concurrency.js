'use strict';
// A bounded worker pool: `worker(item, index)` for every item, at most `limit` at a time, results in input order.
// The first rejection stops the pool: no further item starts, the workers already running settle their current
// item, and the map rejects with that first error (revision 34; before, the other workers kept taking items).
const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let cursor = 0;
  let failure = null;
  const run = async () => {
    while (cursor < items.length && failure === null) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (failure === null) {
          failure = error;
        }
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  await Promise.all(Array.from({ length: workers }, run));
  if (failure !== null) {
    throw failure;
  }
  return results;
};

module.exports = { mapWithConcurrency };
