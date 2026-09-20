'use strict';
// Threshold suggestions backed by replayed evidence (US4 scenario 4). Calibration targets the percentage-change
// rule of FR-014, the one whose false positives reviewers dismiss most; the deviation rule is only described.
//
// The rule, applied per project and metric to the items that fired the percentage-change rule in the window,
// each with its observed |change| and its reviewer outcome:
//   1. fewer than 3 such items and fewer than 14 daily values: no suggestion (insufficient data);
//   2. dismissed items exist and every confirmed item lies above every dismissed one: the smallest multiple of
//      5 strictly above the largest dismissed observation, provided it does not exceed the smallest confirmed one
//      (that value drops every dismissed item and keeps every confirmed one);
//   3. otherwise, with dismissed items: every multiple of 5 between the current threshold and the 95th percentile
//      of the daily values is scored as dismissed items dropped minus twice the confirmed items dropped; the best
//      positive score wins, ties to the lower value, no positive score means no suggestion;
//   4. no dismissed items but the rule fired on more than half of the days: the 90th percentile of the daily
//      values rounded up to a multiple of 5 (the rule is noise on that metric);
//   5. otherwise no suggestion.
// A suggestion within 10 % of the current threshold is withheld. The effect reported for a suggestion is what the
// suggested threshold would have done to the window's items; for no suggestion it is the current threshold's.
const MIN_OBSERVATIONS = 3;
const MIN_DAYS = 14;
const STEP = 5;
const TOLERANCE = 0.1;
const CONFIRMED_WEIGHT = 2;
const NOISY_SHARE = 0.5;

const finite = (values) => values.filter((v) => Number.isFinite(v));

/** Nearest-rank percentile of the values (p in 0..100); null for no values. The input is not mutated. */
const percentile = (values, p) => {
  const sorted = finite(values || []).sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }
  const rank = Math.max(1, Math.min(sorted.length, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
};

const roundUpToFive = (value) => Math.ceil(value / STEP) * STEP;

/** What a threshold would have done to the observed items. */
const effectOf = (threshold, observations) => {
  const kept = observations.filter((o) => threshold === null || threshold === undefined || o.observed >= threshold);
  return {
    items_kept: kept.length,
    items_dropped: observations.length - kept.length,
    confirmed_kept: kept.filter((o) => o.outcome === 'confirmed').length,
  };
};

const multiplesBetween = (a, b) => {
  const low = Math.ceil(Math.min(a, b) / STEP) * STEP;
  const high = Math.floor(Math.max(a, b) / STEP) * STEP;
  const out = [];
  for (let v = low; v <= high; v += STEP) {
    out.push(v);
  }
  return out;
};

const scoreOf = (value, dismissed, confirmed) => {
  const dismissedDropped = dismissed.filter((o) => o.observed < value).length;
  const confirmedDropped = confirmed.filter((o) => o.observed < value).length;
  return dismissedDropped - CONFIRMED_WEIGHT * confirmedDropped;
};

const bestByEvaluation = ({ current, dismissed, confirmed, daily, observed }) => {
  const upper = percentile(daily.length ? daily : observed, 95);
  let best = { value: null, score: 0 };
  for (const value of multiplesBetween(current, roundUpToFive(upper === null ? current : upper))) {
    const score = scoreOf(value, dismissed, confirmed);
    if (score > best.score) {
      best = { value, score };
    }
  }
  return best.value;
};

/**
 * @param {object} options
 * @param {number} options.current the effective percentage-change threshold
 * @param {{ item_id: string, observed: number, outcome: string }[]} options.observations
 * @param {number[]} [options.dailyValues] the window's daily absolute percentage changes
 * @returns {{ suggested: number|null, effect: object, reason: string }}
 */
const suggestThreshold = ({ current, observations = [], dailyValues = [] }) => {
  const obs = observations.filter((o) => Number.isFinite(o.observed));
  const daily = finite(dailyValues);
  const done = (suggested, reason) => ({
    suggested, effect: effectOf(suggested === null ? current : suggested, obs), reason,
  });
  if (obs.length < MIN_OBSERVATIONS && daily.length < MIN_DAYS) {
    return done(null, 'insufficient data');
  }
  const dismissed = obs.filter((o) => o.outcome === 'dismissed');
  const confirmed = obs.filter((o) => o.outcome === 'confirmed');
  let candidate = null;
  let reason = null;
  if (dismissed.length) {
    const maxDismissed = Math.max(...dismissed.map((o) => o.observed));
    const minConfirmed = confirmed.length ? Math.min(...confirmed.map((o) => o.observed)) : Infinity;
    const separator = Math.floor(maxDismissed / STEP) * STEP + STEP;
    if (minConfirmed > maxDismissed && separator <= minConfirmed) {
      candidate = separator;
      reason = 'separates dismissed from confirmed items';
    } else {
      candidate = bestByEvaluation({ current, dismissed, confirmed, daily, observed: obs.map((o) => o.observed) });
      reason = candidate === null ? 'no improving threshold' : 'best trade-off where outcomes overlap';
    }
  } else if (daily.length && daily.filter((v) => v >= current).length / daily.length > NOISY_SHARE) {
    candidate = roundUpToFive(percentile(daily, 90));
    reason = 'rule fires on most days';
  } else {
    return done(null, 'no dismissed items');
  }
  if (candidate !== null && Math.abs(candidate - current) <= TOLERANCE * current) {
    return done(null, 'within tolerance');
  }
  return done(candidate, reason);
};

module.exports = { percentile, roundUpToFive, effectOf, suggestThreshold, STEP, TOLERANCE };
