'use strict';
// Cost Records summed per run and reconciled with the runtime's estimate (FR-049).
const round6 = (n) => Number(n.toFixed(6));

const sumUsage = (records) => {
  const total = {
    cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, calls: 0,
  };
  for (const r of records) {
    total.cost_usd += r.cost_usd || 0;
    total.input_tokens += r.input_tokens || 0;
    total.output_tokens += r.output_tokens || 0;
    total.cache_read_tokens += r.cache_read_tokens || 0;
    total.cache_creation_tokens += r.cache_creation_tokens || 0;
    total.calls += 1;
  }
  total.cost_usd = round6(total.cost_usd);
  return total;
};

/** Compare the recorded sum with the runtime's own total; tolerance is one cent or two percent, whichever is larger. */
const reconcile = ({ recorded, runtime }) => {
  const difference = round6(Math.abs((runtime || 0) - (recorded || 0)));
  const tolerance = Math.max(0.01, 0.02 * (recorded || 0));
  return {
    recorded: round6(recorded || 0),
    runtime: round6(runtime || 0),
    difference,
    within_tolerance: difference <= tolerance,
  };
};

module.exports = { sumUsage, reconcile, round6 };
