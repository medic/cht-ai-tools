'use strict';
// Candidates: deterministic flags on computed changes (FR-006, FR-014). The model never computes these.
const { schemas } = require('../model/schemas');
const { candidateId } = require('../model/identity');
const { roleMatches } = require('./thresholds');

const round3 = (n) => Number(n.toFixed(3));

const unitFromWindows = (windows, metric) => {
  const found = windows.find((w) => w.metric === metric);
  return found && found.unit ? found.unit : 'count';
};

/**
 * @param {object} options
 * @param {object[]} options.changes Computed Changes for one project
 * @param {object} options.project the project (url, host)
 * @param {object} options.thresholds effective thresholds ({ rules, sources })
 * @param {object} options.policy loaded policy (metric roles)
 * @param {string} options.date run date
 * @param {object[]} [options.windows] the project's windows, for units
 * @param {Function} [options.unitOf] alternative unit lookup by metric key
 */
const computeCandidates = ({ changes, project, thresholds, policy, date, windows = [], unitOf = null }) => {
  const roles = policy.thresholds.metric_roles;
  const { rules, sources } = thresholds;
  const unit = (metric) => (unitOf ? unitOf(metric) : unitFromWindows(windows, metric));
  const candidates = [];

  for (const change of changes) {
    const u = unit(change.metric);
    const baselineWindow = change.baseline === 'previous_cycle' ? 'previous_cycle' : 'previous_day';
    const baselineValue = change.baseline === 'previous_cycle'
      ? change.previous_cycle_value
      : change.previous_day_value;
    const evidence = (extra = []) => [
      { window: 'current', value: change.current_value, unit: u },
      ...(baselineValue !== null ? [{ window: baselineWindow, value: baselineValue, unit: u }] : []),
      ...extra,
    ];
    const fired = [];

    if (change.pct_change_vs_previous_day !== null
      && Math.abs(change.pct_change_vs_previous_day) >= rules.pct_change_vs_previous_day) {
      fired.push({
        rule: 'pct_change',
        observed: change.pct_change_vs_previous_day,
        threshold: { source: sources.pct_change_vs_previous_day, value: rules.pct_change_vs_previous_day },
        evidence: evidence(),
      });
    }
    if (change.deviation_sigma !== null && Math.abs(change.deviation_sigma) >= rules.deviation_sigma_vs_trailing) {
      fired.push({
        rule: 'deviation',
        observed: change.deviation_sigma,
        threshold: { source: sources.deviation_sigma_vs_trailing, value: rules.deviation_sigma_vs_trailing },
        evidence: evidence([{
          window: 'trailing_14d',
          value: change.trailing_mean,
          unit: u,
          note: `mean of the trailing daily values; stddev ${round3(change.trailing_stddev)}`,
        }]),
      });
    }
    if (change.monotonic_rise_hours > 0 && change.monotonic_rise_hours >= rules.monotonic_rise_hours) {
      fired.push({
        rule: 'monotonic',
        observed: change.monotonic_rise_hours,
        threshold: { source: sources.monotonic_rise_hours, value: rules.monotonic_rise_hours },
        evidence: evidence(),
      });
    }
    const isTarget = roleMatches(roles.scrape_target, change.metric);
    if (isTarget && change.current_value === 0) {
      fired.push({
        rule: 'target_down', observed: 0, threshold: { source: 'default', value: 0 }, evidence: evidence(),
      });
    }
    const isOutbound = roleMatches(roles.outbound_push_backlog, change.metric);
    if (isOutbound && change.current_value !== null && change.current_value > 0) {
      fired.push({
        rule: 'backlog_absolute',
        observed: change.current_value,
        threshold: { source: 'default', value: 0 },
        evidence: evidence(),
      });
    }
    if (!fired.length) {
      continue;
    }

    const isSentinel = roleMatches(roles.sentinel_backlog, change.metric);
    const sentinelHigh = isSentinel && baselineValue !== null && change.current_value !== null
      && change.current_value > 3 * baselineValue;
    let floor = 'low';
    const highRule = fired.some((f) => f.rule === 'target_down' || f.rule === 'backlog_absolute');
    if (highRule || sentinelHigh) {
      floor = 'high';
    } else if (fired.length >= 2) {
      floor = 'medium';
    }

    for (const f of fired) {
      candidates.push(schemas.Candidate.parse({
        candidate_id: candidateId(project.url, change.metric, f.rule, date),
        project_url: project.url,
        metric: change.metric,
        panel_ref: change.panel_ref,
        rule: f.rule,
        threshold: f.threshold,
        observed: f.observed,
        severity_floor: floor,
        evidence: f.evidence,
        expected_load_window_id: change.expected_load_window_id,
      }));
    }
  }
  return candidates;
};

/** Horizon suppression from feedback notes (FR-029) is filled in by User Story 2; the call site is stable. */
const isNil = (value) => value === null || value === undefined;

const EXCEEDS_FACTOR = 1.25;

/** Does the candidate exceed what the reviewer noted as expected? Otherwise the horizon suppresses it. */
const exceedsExpectation = (candidate, horizon) => {
  if (!isNil(horizon.expected_max)) {
    return candidate.observed > horizon.expected_max;
  }
  if (!isNil(horizon.observed_value)) {
    return candidate.observed > EXCEEDS_FACTOR * horizon.observed_value;
  }
  return false;
};

/**
 * Honour reviewer horizons (FR-029): a candidate for a project and metric with a horizon on or after the
 * run date is suppressed unless it exceeds the noted expectation.
 * @returns {{ kept: object[], suppressed: Array<{ candidate_id, item_id, horizon, reason }> }}
 */
const suppressByHorizon = (candidates, horizons = [], { date = null } = {}) => {
  if (!horizons.length) {
    return { kept: candidates, suppressed: [] };
  }
  const kept = [];
  const suppressed = [];
  for (const candidate of candidates) {
    const horizon = horizons.find((h) => h.project_url === candidate.project_url
      && h.metric === candidate.metric
      && (date === null || h.horizon >= date));
    if (!horizon || exceedsExpectation(candidate, horizon)) {
      kept.push(candidate);
      continue;
    }
    suppressed.push({
      candidate_id: candidate.candidate_id,
      item_id: horizon.item_id || null,
      horizon: horizon.horizon,
      reason: `within the expectation a reviewer noted until ${horizon.horizon}`,
    });
  }
  return { kept, suppressed };
};

module.exports = { computeCandidates, suppressByHorizon };
