'use strict';
// Dashboard template variables in panel expressions (FR-071, research.md R-15). Grafana substitutes them in the
// browser; the datasource proxy does not, so the collect stage must. The instance variable is scoped by
// withInstance (windows.js); this module resolves the rest: the dashboard's own variables to their single
// current value, and Grafana's built-in time variables to the window the watchdog queries.
const SCOPED = new Set(['cht_instance']);
const RESOLUTION_S = 300; // the step of the comparison windows and the resolution of the trailing subquery
const COMPARISON_WINDOW_S = 86400; // every window compares a day against a day
const DEFAULT_SCRAPE_INTERVAL_S = 300; // cht-watchdog's global scrape interval (R-6)
const DURATION = /^\d+(ms|[smhdwy])$/;
// $name, ${name}, ${name:format} and the legacy [[name]] (Grafana "Variable syntax").
const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const VARIABLE = new RegExp(`\\$\\{(${NAME})(?::[^}]*)?\\}|\\$(${NAME})|\\[\\[(${NAME})\\]\\]`, 'g');
const SINGLE_VALUE_TYPES = new Set(['constant', 'custom', 'textbox']);

/** A duration in the largest PromQL unit that divides it exactly. */
const durationText = (seconds) => {
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60]]) {
    if (seconds >= size && seconds % size === 0) {
      return `${seconds / size}${unit}`;
    }
  }
  return `${seconds}s`;
};

/** Grafana's built-in time variables for a watchdog window; $__rate_interval per the Prometheus data source docs. */
const builtinValue = (name, scrapeIntervalS) => {
  switch (name) {
  case '__interval': return durationText(RESOLUTION_S);
  case '__interval_ms': return String(RESOLUTION_S * 1000);
  case '__rate_interval': return durationText(Math.max(RESOLUTION_S + scrapeIntervalS, 4 * scrapeIntervalS));
  case '__range': return durationText(COMPARISON_WINDOW_S);
  case '__range_s': return String(COMPARISON_WINDOW_S);
  case '__range_ms': return String(COMPARISON_WINDOW_S * 1000);
  default: return null;
  }
};

const isBuiltin = (name) => builtinValue(name, DEFAULT_SCRAPE_INTERVAL_S) !== null;

/** Names of the variables an expression uses, in order of first appearance, without the scoped instance variable. */
const variablesIn = (expr) => {
  const names = [];
  for (const match of String(expr).matchAll(VARIABLE)) {
    const name = match[1] || match[2] || match[3];
    if (!SCOPED.has(name) && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
};

const singleValue = (value) => {
  if (Array.isArray(value)) {
    return value.length === 1 ? singleValue(value[0]) : null;
  }
  if (typeof value !== 'string' || !value || value.startsWith('$__')) {
    return null;
  }
  return value;
};

/**
 * What each templating variable of a dashboard document resolves to: a literal, or null when it has no single value
 * (a query variable is a selection, a multi-value custom variable a list, a datasource variable not a PromQL value).
 */
const dashboardVariables = (doc) => {
  const list = (doc && doc.dashboard && doc.dashboard.templating && doc.dashboard.templating.list) || [];
  const out = {};
  for (const variable of list) {
    if (!variable || !variable.name || SCOPED.has(variable.name)) {
      continue;
    }
    const current = variable.current ? variable.current.value : undefined;
    if (variable.type === 'interval') {
      // A concrete interval stands; "auto" means Grafana divides the range by a step count, which for a day-long
      // window with the default thirty steps lands near the watchdog's own resolution.
      out[variable.name] = typeof current === 'string' && DURATION.test(current) ? current : durationText(RESOLUTION_S);
    } else if (SINGLE_VALUE_TYPES.has(variable.type)) {
      out[variable.name] = singleValue(current);
    } else {
      out[variable.name] = null;
    }
  }
  return out;
};

/**
 * Substitute every variable in a scoped expression. Built-ins resolve to the watchdog's window, dashboard variables to
 * their literal; anything else stays in place and is named in `unresolved`, so the caller never sends it.
 */
const resolveExpression = (expr, { variables = {}, scrapeIntervalS = DEFAULT_SCRAPE_INTERVAL_S } = {}) => {
  const unresolved = [];
  const query = String(expr).replace(VARIABLE, (text, braced, plain, legacy) => {
    const name = braced || plain || legacy;
    const value = builtinValue(name, scrapeIntervalS) ?? variables[name] ?? null;
    if (value === null) {
      if (!unresolved.includes(name)) {
        unresolved.push(name);
      }
      return text;
    }
    return String(value);
  });
  return { query, unresolved };
};

module.exports = {
  variablesIn, dashboardVariables, resolveExpression, durationText, isBuiltin,
  RESOLUTION_S, COMPARISON_WINDOW_S, DEFAULT_SCRAPE_INTERVAL_S,
};
