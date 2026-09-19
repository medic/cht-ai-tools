'use strict';
// Metric keys: a panel expression with the instance matcher removed, its base metric name, and panel helpers.
const FUNCTION_NAMES = new Set([
  'rate', 'irate', 'increase', 'delta', 'sum', 'avg', 'min', 'max', 'count', 'abs', 'histogram_quantile', 'time',
  'max_over_time', 'min_over_time', 'avg_over_time', 'sum_over_time', 'by', 'without', 'on', 'ignoring', 'group_left',
  'group_right', 'offset', 'bool',
]);

const IDENTIFIER_PATTERN = /([a-zA-Z_:][a-zA-Z0-9_:]*)(\s*\()?/g;

/** The first identifier in an expression that is not a function call; `up` for `up{job="cht"}`. */
const baseMetricName = (expr) => {
  for (const match of String(expr || '').matchAll(IDENTIFIER_PATTERN)) {
    if (match[2] || FUNCTION_NAMES.has(match[1])) {
      continue;
    }
    return match[1];
  }
  return null;
};

/** Remove the per-project instance matcher and normalise whitespace. */
const stripInstanceMatcher = (expr) => String(expr || '')
  .replace(/\binstance\s*=~?\s*"[^"]*"\s*,?\s*/g, '')
  .replace(/,\s*}/g, '}')
  .replace(/\{\s*\}/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** Every form under which a collected metric key or panel expression may be quoted. */
const keyForms = (expr) => {
  const forms = new Set();
  const text = String(expr || '').trim();
  if (!text) {
    return forms;
  }
  forms.add(text);
  forms.add(text.replace(/\s+/g, ' '));
  forms.add(stripInstanceMatcher(text));
  const base = baseMetricName(text);
  if (base) {
    forms.add(base);
  }
  return forms;
};

const sameMetric = (a, b) => {
  if (a === b) {
    return true;
  }
  const strippedA = stripInstanceMatcher(a);
  const strippedB = stripInstanceMatcher(b);
  return strippedA === strippedB || baseMetricName(a) === baseMetricName(b);
};

/** Panels of a dashboard including those nested in row panels. */
const flatPanels = (dashboard) => {
  const out = [];
  const visit = (panels) => {
    for (const panel of panels || []) {
      out.push(panel);
      if (Array.isArray(panel.panels)) {
        visit(panel.panels);
      }
    }
  };
  visit(dashboard && dashboard.panels);
  return out;
};

module.exports = { baseMetricName, stripInstanceMatcher, keyForms, sameMetric, flatPanels, FUNCTION_NAMES };
