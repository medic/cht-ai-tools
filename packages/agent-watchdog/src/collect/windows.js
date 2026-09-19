'use strict';
// Metric windows per project and metric (FR-004): current, previous day, previous week, previous cycle and the
// trailing fourteen days as daily maxima (research.md R-6).
const codes = require('../cli/exit-codes');
const { normaliseHost } = require('../config/policy');
const { schemas } = require('../model/schemas');

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
  return `${expr}{instance="${host}"}`;
};

const trailingQuery = (expr) => `max_over_time(${expr}[1d])`;

const SCRAPE_PANEL_REF = { dashboard_uid: 'targets', panel_id: 0, panel_title: 'Scrape target health', ref_id: 'up' };

/** One query spec per unique metric key: the first panel in priority order wins, plus the scrape-target metric. */
const metricSpecs = (discovery) => {
  const specs = new Map();
  for (const dashboard of discovery.dashboards) {
    for (const panel of dashboard.panels) {
      if (panel.per_project && !specs.has(panel.metric)) {
        specs.set(panel.metric, {
          metric: panel.metric,
          expr: panel.expr,
          unit: panel.unit,
          panel_ref: {
            dashboard_uid: dashboard.uid, panel_id: panel.panel_id, panel_title: panel.title, ref_id: panel.ref_id,
          },
        });
      }
    }
  }
  const scrape = discovery.scrape_target_metric;
  if (scrape && !specs.has(scrape)) {
    specs.set(scrape, { metric: scrape, expr: scrape, unit: 'state', panel_ref: SCRAPE_PANEL_REF });
  }
  return [...specs.values()];
};

const pickSeries = (result, host) => result.find((series) => {
  const instance = series.metric && series.metric.instance;
  return !instance || normaliseHost(instance) === host;
}) || result[0] || null;

/**
 * Collect every window for every per-project metric of one project.
 * @returns {{ project_url: string, windows: object[] }}
 */
const collectWindows = async ({ grafana, project, discovery, runStart, activeWindow = null, logger = noop }) => {
  const bounds = windowBounds(runStart, { activeWindow });
  const windows = [];
  for (const spec of metricSpecs(discovery)) {
    const query = withInstance(spec.expr, project.host);
    for (const bound of bounds) {
      let values = [];
      let available = true;
      let reason = null;
      try {
        const result = await grafana.queryRange({
          query: bound.daily ? trailingQuery(query) : query,
          start: seconds(bound.start),
          end: seconds(bound.end),
          step: bound.step_s,
        });
        const series = pickSeries(result, project.host);
        values = series ? series.values.filter(([, value]) => Number.isFinite(value)) : [];
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
        reason = `query failed: ${error.message}`;
        logger.warn('collect.query_failed', {
          project: project.host, metric: spec.metric, window: bound.window, message: error.message,
        });
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
      }));
    }
  }
  return { project_url: project.url, windows };
};

module.exports = { windowBounds, withInstance, trailingQuery, metricSpecs, collectWindows, DAY, MIN_HISTORY_DAYS };
