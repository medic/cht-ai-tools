'use strict';
// Metric kinds (FR-076, research.md R-18): how a metric key is analysed. A gauge is compared as a level; a counter as
// the increase over each window; an uptime yields restarts; a clock is excluded. The kind comes from the reviewed
// thresholds policy (`metric_kinds`) by the bare metric name or `name{labels}`; expressions built with functions or
// arithmetic are gauges, since the dashboard author already derived a meaningful quantity.
const KINDS = Object.freeze(['gauge', 'counter', 'uptime', 'clock']);
const AGGREGATES = Object.freeze(['level', 'increase', 'restarts', 'excluded']);
// A display-only comparison keeps a zero-valued series visible on a dashboard; it does not change the metric.
const DISPLAY_COMPARISON = /\s*>=\s*0$/;
const SUM_WRAPPER = /^sum\((.*)\)$/s;
const SELECTOR = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^{}]*\})?$/;
// An uptime that falls below this fraction of the previous sample was reset: a restart, not noise.
const RESTART_FRACTION = 0.5;

/** The metric key without a display comparison or a plain `sum(...)` wrapper. */
const bareKey = (key) => {
  let bare = String(key || '').trim().replace(DISPLAY_COMPARISON, '').trim();
  const summed = SUM_WRAPPER.exec(bare);
  if (summed) {
    bare = summed[1].trim();
  }
  return bare;
};

/** The kind of a metric key under a policy `{ clock, uptime, counter }` of names or `name{labels}` entries. */
const metricKind = (key, kinds = {}) => {
  const bare = bareKey(key);
  const match = SELECTOR.exec(bare);
  if (!match) {
    return 'gauge';
  }
  const name = match[1];
  for (const kind of ['clock', 'uptime', 'counter']) {
    if ((kinds[kind] || []).some((entry) => entry === bare || entry === name)) {
      return kind;
    }
  }
  return 'gauge';
};

/** The increase of a counter over sampled values, counting a reset as an increase from zero (Prometheus increase). */
const increaseOver = (values) => {
  if (!Array.isArray(values) || values.length < 2) {
    return values && values.length === 1 ? 0 : null;
  }
  let total = 0;
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i][1] - values[i - 1][1];
    total += delta >= 0 ? delta : values[i][1];
  }
  return total;
};

/** Daily increases from daily maxima: the first day has no predecessor and is dropped. */
const dailyIncreases = (dailyMaxima) => {
  const out = [];
  for (let i = 1; i < (dailyMaxima || []).length; i += 1) {
    const [ts, value] = dailyMaxima[i];
    const previous = dailyMaxima[i - 1][1];
    out.push([ts, value >= previous ? value - previous : value]);
  }
  return out;
};

/** Restarts in a window: samples that fell below half of their predecessor. */
const restartsIn = (values) => {
  let restarts = 0;
  for (let i = 1; i < (values || []).length; i += 1) {
    const previous = values[i - 1][1];
    if (previous > 0 && values[i][1] < RESTART_FRACTION * previous) {
      restarts += 1;
    }
  }
  return restarts;
};

module.exports = {
  KINDS, AGGREGATES, RESTART_FRACTION, bareKey, metricKind, increaseOver, dailyIncreases, restartsIn,
};
