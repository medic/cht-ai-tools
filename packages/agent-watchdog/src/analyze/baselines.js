'use strict';
// Arithmetic that lives in code, never in a prompt (constitution III, FR-006).

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Population standard deviation. */
const stddev = (values) => {
  if (!values.length) {
    return null;
  }
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
};

/** Percentage change against the absolute baseline; null when either side is missing or the baseline is zero. */
const pctChange = (current, baseline) => {
  if (current === null || current === undefined || baseline === null || baseline === undefined || baseline === 0) {
    return null;
  }
  return ((current - baseline) / Math.abs(baseline)) * 100;
};

/**
 * Hours covered by the run of consecutive non-decreasing samples that ends at the last sample, provided the run
 * actually rises (last > first). A flat line or a final drop counts as no rise.
 * @param {Array<[number, number]>} values [unix_seconds, value] pairs in time order
 * @param {number} stepS sample spacing in seconds, used when timestamps are missing
 */
const monotonicRunHours = (values, stepS) => {
  if (!Array.isArray(values) || values.length < 2) {
    return 0;
  }
  let i = values.length - 1;
  while (i > 0 && values[i][1] >= values[i - 1][1]) {
    i -= 1;
  }
  const steps = values.length - 1 - i;
  if (steps === 0 || values[values.length - 1][1] <= values[i][1]) {
    return 0;
  }
  const lastTs = values[values.length - 1][0];
  const firstTs = values[i][0];
  const haveTimestamps = Number.isFinite(lastTs) && Number.isFinite(firstTs) && lastTs > firstTs;
  const spanSeconds = haveTimestamps ? lastTs - firstTs : steps * stepS;
  return spanSeconds / 3600;
};

module.exports = { mean, stddev, pctChange, monotonicRunHours };
