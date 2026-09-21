'use strict';
// Deterministic comparison of each metric across its windows (FR-006, FR-007).
const { schemas } = require('../model/schemas');
const { mean, stddev, pctChange, monotonicRunHours } = require('./baselines');
const { metricKind, increaseOver, dailyIncreases, restartsIn } = require('./kinds');

const lastValue = (window) => {
  if (!window || !window.available || !window.values.length) {
    return null;
  }
  return window.values[window.values.length - 1][1];
};

const groupByMetric = (windows) => {
  const groups = new Map();
  for (const window of windows) {
    if (!groups.has(window.metric)) {
      groups.set(window.metric, []);
    }
    groups.get(window.metric).push(window);
  }
  return groups;
};

/** Daily trailing values excluding the day the run starts in. */
const trailingValues = (trailing, current) => {
  if (!trailing || !trailing.available) {
    return null;
  }
  const currentStart = current ? Date.parse(current.start) / 1000 : null;
  const points = currentStart === null
    ? trailing.values.slice(0, -1)
    : trailing.values.filter(([ts]) => ts <= currentStart);
  return points.map(([, value]) => value);
};

/** The increase of a counter over a window, or null when the window is unavailable. */
const increaseValue = (window) => (window && window.available ? increaseOver(window.values) : null);

/** Daily increases of a counter from its trailing daily maxima, excluding the day the run starts in. */
const trailingIncreases = (trailing, current) => {
  if (!trailing || !trailing.available) {
    return null;
  }
  const currentStart = current ? Date.parse(current.start) / 1000 : null;
  const increases = dailyIncreases(trailing.values);
  const points = currentStart === null ? increases.slice(0, -1) : increases.filter(([ts]) => ts <= currentStart);
  return points.map(([, value]) => value);
};

const AGGREGATE_BY_KIND = { gauge: 'level', counter: 'increase', uptime: 'restarts', clock: 'excluded' };

/**
 * @param {object} options windows, project, activeWindow, `kinds` (thresholds.yaml `metric_kinds`) deciding how
 *   each metric is compared (FR-076): gauges and clocks as levels, counters as increases, uptimes as restarts; and
 *   `metrics`, the analysable metric keys of the run's discovery (null compares every stored metric).
 * @returns {object[]} one Computed Change per metric key present in the windows
 */
const computeChanges = ({ windows, project, activeWindow = null, kinds = {}, metrics = null }) => {
  const changes = [];
  // Only the metrics discovery marked analysable (FR-075, revision 24): a stored window of a reference line, or of
  // a metric a later discovery dropped, is not compared. Without a list every stored metric is.
  const analysable = Array.isArray(metrics) ? new Set(metrics) : null;
  for (const [metric, group] of groupByMetric(windows)) {
    if (analysable && !analysable.has(metric)) {
      continue;
    }
    const byName = (name) => group.find((w) => w.window === name) || null;
    const kind = metricKind(metric, kinds);
    const valueOf = kind === 'counter' ? increaseValue : lastValue;
    const current = byName('current');
    const currentValue = valueOf(current);
    const previousDay = valueOf(byName('previous_day'));
    const previousWeek = valueOf(byName('previous_week'));
    const previousCycle = valueOf(byName('previous_cycle'));
    const useCycle = Boolean(activeWindow) && previousCycle !== null;
    const baselineValue = useCycle ? previousCycle : previousDay;
    const daily = kind === 'counter'
      ? trailingIncreases(byName('trailing_14d'), current)
      : trailingValues(byName('trailing_14d'), current);
    const compares = kind === 'gauge' || kind === 'counter';
    const trailingMean = compares && daily && daily.length ? mean(daily) : null;
    const trailingStddev = compares && daily && daily.length ? stddev(daily) : null;
    const deviation = currentValue !== null && trailingMean !== null && trailingStddev
      ? (currentValue - trailingMean) / trailingStddev
      : null;
    const rising = kind === 'gauge' && current && current.available;
    changes.push(schemas.ComputedChange.parse({
      project_url: project.url,
      metric,
      panel_ref: group[0].panel_ref,
      current_value: currentValue,
      previous_day_value: previousDay,
      previous_week_value: previousWeek,
      previous_cycle_value: previousCycle,
      pct_change_vs_previous_day: compares ? pctChange(currentValue, baselineValue) : null,
      trailing_mean: trailingMean,
      trailing_stddev: trailingStddev,
      deviation_sigma: deviation,
      monotonic_rise_hours: rising ? monotonicRunHours(current.values, current.step_s) : 0,
      baseline: useCycle ? 'previous_cycle' : 'previous_day',
      expected_load_window_id: activeWindow ? activeWindow.id : null,
      kind,
      aggregate: AGGREGATE_BY_KIND[kind],
      restarts_24h: kind === 'uptime' && current && current.available ? restartsIn(current.values) : null,
    }));
  }
  return changes;
};

module.exports = { computeChanges, trailingValues, lastValue };
