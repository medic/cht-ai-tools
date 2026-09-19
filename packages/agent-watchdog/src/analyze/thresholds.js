'use strict';
// Effective candidate thresholds per project and the metric-role matching used by the FR-014 rules.

const RULES = ['pct_change_vs_previous_day', 'deviation_sigma_vs_trailing', 'monotonic_rise_hours'];

/**
 * @param {object} thresholds the policy thresholds document
 * @param {object|null} overrides the project's partial thresholds
 * @param {object} [options]
 * @param {boolean} [options.globalSource] true when the thresholds file came from the deployment, not the package
 */
const effectiveThresholds = (thresholds, overrides = null, { globalSource = false } = {}) => {
  const rules = {};
  const sources = {};
  for (const rule of RULES) {
    if (overrides && typeof overrides[rule] === 'number') {
      rules[rule] = overrides[rule];
      sources[rule] = 'project';
    } else {
      rules[rule] = thresholds.candidate_rules[rule];
      sources[rule] = globalSource ? 'global' : 'default';
    }
  }
  return { rules, sources };
};

const SELECTOR = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?$/;

const parseSelector = (text) => {
  const match = SELECTOR.exec(String(text).trim());
  if (!match) {
    return null;
  }
  const matchers = match[2] ? match[2].split(',').map((m) => m.trim()).filter(Boolean) : [];
  return { name: match[1], matchers };
};

/** A role metric matches a key when they are equal, or share the base name and the key carries every role matcher. */
const roleMatches = (roleMetric, metricKey) => {
  if (roleMetric === metricKey) {
    return true;
  }
  const role = parseSelector(roleMetric);
  const key = parseSelector(metricKey);
  if (!role || !key || role.name !== key.name) {
    return false;
  }
  return role.matchers.every((matcher) => key.matchers.includes(matcher));
};

module.exports = { effectiveThresholds, roleMatches, parseSelector, RULES };
