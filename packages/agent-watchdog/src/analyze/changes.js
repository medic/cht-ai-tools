'use strict';
// Deterministic comparison of each metric across its windows (FR-006, FR-007).
const { schemas } = require('../model/schemas');
const { mean, stddev, pctChange, monotonicRunHours } = require('./baselines');

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

/**
 * @returns {object[]} one Computed Change per metric key present in the windows
 */
const computeChanges = ({ windows, project, activeWindow = null }) => {
  const changes = [];
  for (const [metric, group] of groupByMetric(windows)) {
    const byName = (name) => group.find((w) => w.window === name) || null;
    const current = byName('current');
    const currentValue = lastValue(current);
    const previousDay = lastValue(byName('previous_day'));
    const previousWeek = lastValue(byName('previous_week'));
    const previousCycle = lastValue(byName('previous_cycle'));
    const useCycle = Boolean(activeWindow) && previousCycle !== null;
    const baselineValue = useCycle ? previousCycle : previousDay;
    const daily = trailingValues(byName('trailing_14d'), current);
    const trailingMean = daily && daily.length ? mean(daily) : null;
    const trailingStddev = daily && daily.length ? stddev(daily) : null;
    const deviation = currentValue !== null && trailingMean !== null && trailingStddev
      ? (currentValue - trailingMean) / trailingStddev
      : null;
    changes.push(schemas.ComputedChange.parse({
      project_url: project.url,
      metric,
      panel_ref: group[0].panel_ref,
      current_value: currentValue,
      previous_day_value: previousDay,
      previous_week_value: previousWeek,
      previous_cycle_value: previousCycle,
      pct_change_vs_previous_day: pctChange(currentValue, baselineValue),
      trailing_mean: trailingMean,
      trailing_stddev: trailingStddev,
      deviation_sigma: deviation,
      monotonic_rise_hours: current && current.available ? monotonicRunHours(current.values, current.step_s) : 0,
      baseline: useCycle ? 'previous_cycle' : 'previous_day',
      expected_load_window_id: activeWindow ? activeWindow.id : null,
    }));
  }
  return changes;
};

module.exports = { computeChanges, trailingValues, lastValue };
