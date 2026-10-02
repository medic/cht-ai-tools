'use strict';
// Live single-window query for the model's `query_metric` tool (FR-003): templated PromQL only,
// one of the five named windows, executed through the Grafana datasource proxy.
const { windowBounds, trailingQuery, queryFor, unresolvedReason, pickSeries, ManySeriesError } = require('./windows');

/**
 * `specFor(metric)` (sync or async) returns the discovery's query spec for a metric key: its panel expression, the
 * dashboard's variables and the ones it left unresolved (FR-071). Without one, the metric key is scoped as written.
 */
const createQueryWindow = ({
  grafana, runStart, activeWindowFor = () => null, specFor = () => null,
}) => async (project, metric, window) => {
  const bounds = windowBounds(runStart, { activeWindow: activeWindowFor(project) }).find((b) => b.window === window);
  if (!bounds) {
    return { available: false, unavailable_reason: `unknown window "${window}"` };
  }
  const spec = (await specFor(metric)) || {};
  const { query: expr, unresolved } = queryFor({
    expr: spec.expr || metric, variables: spec.variables || {}, unresolved: spec.unresolved || [],
  }, project.host);
  if (unresolved.length) {
    return { available: false, unavailable_reason: unresolvedReason(unresolved) };
  }
  const query = bounds.daily ? trailingQuery(expr) : expr;
  const series = await grafana.queryRange({
    query,
    start: Math.floor(bounds.start.getTime() / 1000),
    end: Math.floor(bounds.end.getTime() / 1000),
    step: bounds.step_s,
  });
  const base = {
    project_url: project.url,
    metric,
    window,
    start: bounds.start.toISOString(),
    end: bounds.end.toISOString(),
    step_s: bounds.step_s,
    // The panel's unit from the discovery spec, as the collected windows carry it (revision 34).
    unit: spec.unit || 'count',
  };
  // The same series rule as collection (FR-075, revisions 34 and 36): several matching series are refused, and a
  // single series without the project's instance label (a target-scoped panel) is the answer.
  const { series: chosen, many } = pickSeries(series, project.host);
  if (many) {
    return { ...base, values: [], available: false, unavailable_reason: new ManySeriesError(many).message };
  }
  const values = chosen
    ? chosen.values.filter((pair) => Number.isFinite(Array.isArray(pair) ? pair[1] : pair))
    : [];
  return {
    ...base,
    values,
    available: values.length > 0,
    unavailable_reason: values.length > 0 ? null : 'no series returned',
  };
};

module.exports = { createQueryWindow };
