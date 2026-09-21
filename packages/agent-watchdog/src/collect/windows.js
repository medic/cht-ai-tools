'use strict';
// Metric windows per project and metric (FR-004): current, previous day, previous week, previous cycle and the
// trailing fourteen days as daily maxima (research.md R-6).
const codes = require('../cli/exit-codes');
const { normaliseHost } = require('../config/policy');
const { schemas } = require('../model/schemas');
const { resolveExpression, durationText, RESOLUTION_S } = require('./variables');

const DAY = 86400;
const TRAILING_DAYS = 20;
const MIN_HISTORY_DAYS = 14;
const noop = { debug() {}, info() {}, warn() {}, error() {} };

const seconds = (date) => Math.floor(date.getTime() / 1000);

/** The named windows for a run start. previous_cycle is present only when an expected-load window is active. */
const windowBounds = (runStart, { activeWindow = null } = {}) => {
  const at = (secondsBefore) => new Date(runStart.getTime() - secondsBefore * 1000);
  const bounds = [
    { window: 'current', start: at(DAY), end: at(0), step_s: 300, daily: false },
    { window: 'previous_day', start: at(2 * DAY), end: at(DAY), step_s: 300, daily: false },
    { window: 'previous_week', start: at(8 * DAY), end: at(7 * DAY), step_s: 300, daily: false },
  ];
  if (activeWindow && activeWindow.cycle_days) {
    const cycle = activeWindow.cycle_days;
    bounds.push({
      window: 'previous_cycle', start: at((cycle + 1) * DAY), end: at(cycle * DAY), step_s: 300, daily: false,
    });
  }
  bounds.push({ window: 'trailing_14d', start: at(TRAILING_DAYS * DAY), end: at(0), step_s: DAY, daily: true });
  return bounds;
};

// PromQL words that look like metric names but are not selectors.
const KEYWORDS = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'offset', 'bool', 'and', 'or', 'unless', 'atan2',
]);

/** Add an instance matcher to the first series selector of an expression that has none. */
const scopeFirstSelector = (expr, host) => {
  const identifier = /([a-zA-Z_:][a-zA-Z0-9_:]*)(?=\s*(?:[[)+\-*/%^]|[<>=!]=?|$|\s))/g;
  for (const match of expr.matchAll(identifier)) {
    const after = expr.slice(match.index + match[0].length).trimStart();
    if (!KEYWORDS.has(match[1]) && !after.startsWith('(') && !/^\d/.test(match[1])) {
      const end = match.index + match[0].length;
      return `${expr.slice(0, end)}{instance="${host}"}${expr.slice(end)}`;
    }
  }
  return `${expr}{instance="${host}"}`;
};

/** Substitute the dashboard's instance variable with a literal host, or add an instance matcher. */
const withInstance = (expr, host) => {
  if (expr.includes('$cht_instance')) {
    return expr
      .replace(/instance\s*=~\s*"\$cht_instance"/g, `instance="${host}"`)
      .replace(/\$cht_instance/g, host);
  }
  if (/\{[^}]*\}/.test(expr)) {
    return expr.replace(/\{([^}]*)\}/, (match, inner) => {
      const trimmed = inner.trim();
      return `{${trimmed ? `${trimmed}, ` : ''}instance="${host}"}`;
    });
  }
  return scopeFirstSelector(expr, host);
};

// A bare series selector: a metric name with optional label matchers and nothing else.
const SELECTOR = /^\s*[a-zA-Z_:][a-zA-Z0-9_:]*\s*(\{[^{}]*\})?\s*$/;
const TRAILING_RESOLUTION = durationText(RESOLUTION_S);

/**
 * Daily maxima for the trailing baseline (R-6). A range selector applies to series selectors only; any other
 * expression needs the subquery form, evaluated at the comparison windows' resolution (R-15).
 */
const trailingQuery = (expr) => (SELECTOR.test(expr)
  ? `max_over_time(${expr}[1d])`
  : `max_over_time((${expr})[1d:${TRAILING_RESOLUTION}])`);

const unresolvedReason = (names) => {
  const list = names.map((name) => `$${name}`).join(', ');
  return `unresolved variable${names.length > 1 ? 's' : ''} ${list}`;
};

class UnresolvedVariableError extends Error {
  constructor(names) {
    super(unresolvedReason(names));
    this.name = 'UnresolvedVariableError';
    this.variables = names;
  }
}

const SCRAPE_PANEL_REF = { dashboard_uid: 'targets', panel_id: 0, panel_title: 'Scrape target health', ref_id: 'up' };

/** One query spec per unique metric key: the first panel in priority order wins, plus the scrape-target metric. */
const metricSpecs = (discovery) => {
  const specs = new Map();
  for (const dashboard of discovery.dashboards) {
    for (const panel of dashboard.panels) {
      // A reference line is a comparison drawn beside another metric, not a metric of its own (FR-075, revision 24).
      if (panel.per_project && !panel.breakdown && !panel.reference_line && !specs.has(panel.metric)) {
        specs.set(panel.metric, {
          metric: panel.metric,
          expr: panel.expr,
          unit: panel.unit,
          variables: dashboard.variables || {},
          unresolved: panel.unresolved || [],
          panel_ref: {
            dashboard_uid: dashboard.uid, panel_id: panel.panel_id, panel_title: panel.title, ref_id: panel.ref_id,
          },
        });
      }
    }
  }
  const scrape = discovery.scrape_target_metric;
  if (scrape && !specs.has(scrape)) {
    specs.set(scrape, {
      metric: scrape, expr: scrape, unit: 'state', variables: {}, unresolved: [], panel_ref: SCRAPE_PANEL_REF,
    });
  }
  return [...specs.values()];
};

/** The query spec for a metric key of a discovery document, or null when no panel produced it. */
const metricSpecFor = (discovery) => {
  const specs = new Map(metricSpecs(discovery).map((spec) => [spec.metric, spec]));
  return (metric) => specs.get(metric) || null;
};

/** The expression to send for one project: instance scoped, variables resolved; `unresolved` names what blocks it. */
const queryFor = (spec, host) => {
  const { query, unresolved } = resolveExpression(withInstance(spec.expr, host), { variables: spec.variables || {} });
  return { query, unresolved: [...new Set([...(spec.unresolved || []), ...unresolved])] };
};

/** The series a scoped query returned for the project: those with the project's instance label, or none at all. */
const seriesFor = (result, host) => result.filter((series) => {
  const instance = series.metric && series.metric.instance;
  return !instance || normaliseHost(instance) === host;
});

const IDENTITY_LABELS = new Set(['__name__', 'instance', 'job']);

/** The labels whose values differ across series: what a breakdown is by. */
const varyingLabels = (series) => {
  const values = new Map();
  for (const s of series) {
    for (const [label, value] of Object.entries(s.metric || {})) {
      if (!IDENTITY_LABELS.has(label)) {
        values.set(label, (values.get(label) || new Set()).add(value));
      }
    }
  }
  return [...values.entries()].filter(([, set]) => set.size > 1).map(([label]) => label).sort();
};

class ManySeriesError extends Error {
  constructor(series) {
    const labels = varyingLabels(series);
    const which = labels.length ? labels.join(', ') : 'none differ';
    super(`${series.length} series, not one per project (labels: ${which})`);
    this.name = 'ManySeriesError';
  }
}

/** What the data volume holds for a comparison or trailing window (FR-072); the current window is always fetched. */
const reusable = async (history, metric, bound) => {
  if (!history || bound.window === 'current') {
    return null;
  }
  return bound.daily ? history.ledgerWindow(metric, bound) : history.storedWindow(metric, bound);
};

/**
 * Collect every window for every per-project metric of one project. With a `history` (src/collect/history.js) the
 * comparison windows come from stored runs and the trailing baseline from the ledger when they can (FR-072).
 * @returns {{ project_url: string, windows: object[], stats: { fetched: number, reused: number, queries: number } }}
 */
const collectWindows = async ({
  grafana, project, discovery, runStart, activeWindow = null, logger = noop, history = null,
}) => {
  const bounds = windowBounds(runStart, { activeWindow });
  const windows = [];
  const stats = { fetched: 0, reused: 0, queries: 0 };
  for (const spec of metricSpecs(discovery)) {
    const { query, unresolved } = queryFor(spec, project.host);
    if (unresolved.length) {
      // A variable with no single value cannot be sent (Prometheus would answer 400): the windows are recorded as
      // unavailable, named once, and no query is made (FR-071).
      logger.warn('collect.unresolved_variable', {
        project: project.host, metric: spec.metric, dashboard_uid: spec.panel_ref.dashboard_uid,
        panel_id: spec.panel_ref.panel_id, variables: unresolved,
      });
    }
    for (const bound of bounds) {
      let values = [];
      let available = true;
      let reason = null;
      let source = 'fetched';
      try {
        if (unresolved.length) {
          throw new UnresolvedVariableError(unresolved);
        }
        const reused = await reusable(history, spec.metric, bound);
        if (reused) {
          values = reused.values;
          source = reused.source;
          stats.reused += 1;
        } else {
          stats.fetched += 1;
          stats.queries += 1;
          const result = await grafana.queryRange({
            query: bound.daily ? trailingQuery(query) : query,
            start: seconds(bound.start),
            end: seconds(bound.end),
            step: bound.step_s,
          });
          const matching = seriesFor(result, project.host);
          if (matching.length > 1) {
            // A metric that is one series per project (FR-075): several series mean the panel is a breakdown the
            // discovery could not see in the expression, and no series is picked over the others.
            throw new ManySeriesError(matching);
          }
          const series = matching[0] || result[0] || null;
          values = series ? series.values.filter(([, value]) => Number.isFinite(value)) : [];
          if (history && values.length && bound.window === 'current') {
            history.recordCurrent(spec.metric, values);
          } else if (history && values.length && bound.daily) {
            history.backfill(spec.metric, values);
          }
        }
        if (!values.length) {
          available = false;
          reason = 'no data';
        } else if (bound.daily && values.length < MIN_HISTORY_DAYS) {
          available = false;
          reason = `insufficient history: ${values.length} days`;
        }
      } catch (error) {
        if (error instanceof codes.ExitError) {
          throw error;
        }
        available = false;
        if (error instanceof UnresolvedVariableError || error instanceof ManySeriesError) {
          reason = error.message;
        } else {
          reason = `query failed: ${error.message}`;
          logger.warn('collect.query_failed', {
            project: project.host, metric: spec.metric, window: bound.window, status: error.status || null,
            message: error.message,
          });
        }
      }
      windows.push(schemas.MetricWindow.parse({
        project_url: project.url,
        metric: spec.metric,
        panel_ref: spec.panel_ref,
        window: bound.window,
        start: bound.start.toISOString(),
        end: bound.end.toISOString(),
        step_s: bound.step_s,
        unit: spec.unit,
        values: available ? values : [],
        available,
        unavailable_reason: reason,
        source,
      }));
    }
  }
  return { project_url: project.url, windows, stats };
};

module.exports = {
  windowBounds, withInstance, trailingQuery, metricSpecs, metricSpecFor, queryFor, unresolvedReason, collectWindows,
  DAY, MIN_HISTORY_DAYS,
};
