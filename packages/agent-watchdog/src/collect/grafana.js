'use strict';
// Grafana client: dashboards, search, annotations and the Prometheus datasource proxy (research.md R-5).
// Read-only, bearer-token authenticated, bounded by AGENT_WATCHDOG_HTTP_TIMEOUT_MS.
const codes = require('../cli/exit-codes');

class HttpError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const noop = { debug() {}, info() {}, warn() {}, error() {} };

const toNumber = (value) => Number(value);

/**
 * @param {object} options
 * @param {string} options.baseUrl Grafana base URL
 * @param {string} options.token service-account token (Viewer role)
 * @param {string} options.datasourceUid Prometheus datasource uid proxied through Grafana
 * @param {number} [options.timeoutMs] per-request timeout
 * @param {Function} [options.fetch] fetch implementation (tests inject a fake)
 * @param {object} [options.logger]
 */
const createGrafanaClient = (options) => {
  const { baseUrl, token, datasourceUid, timeoutMs = 15000, fetch = globalThis.fetch, logger = noop } = options;
  const base = String(baseUrl).replace(/\/+$/, '');
  const proxyPath = `/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}`;

  const request = async (pathname, params = {}) => {
    const url = new URL(`${base}${pathname}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    const started = process.hrtime.bigint();
    let response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      logger.warn('grafana.unreachable', { path: url.pathname, reason: error.name, message: error.message });
      throw new codes.ExitError(codes.UNAVAILABLE, `metrics source unreachable: ${error.message}`, {
        path: url.pathname,
        cause: error.name,
      });
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    logger.debug('grafana.request', { path: url.pathname, status: response.status, duration_ms: durationMs });
    if (response.status === 401 || response.status === 403) {
      const reason = `Grafana rejected the service-account token (${response.status}) for ${url.pathname}`;
      throw new codes.ExitError(codes.CONFIG, reason);
    }
    if (!response.ok) {
      let body = null;
      try {
        body = await response.text();
      } catch {
        body = null;
      }
      throw new HttpError(response.status, `Grafana returned ${response.status} for ${url.pathname}`, body);
    }
    return response.json();
  };

  const prometheus = async (endpoint, params) => {
    const envelope = await request(`${proxyPath}/api/v1/${endpoint}`, params);
    if (!envelope || envelope.status !== 'success') {
      const type = (envelope && envelope.errorType) || 'error';
      const detail = (envelope && envelope.error) || 'unknown error';
      throw new Error(`Prometheus ${endpoint} failed: ${type}: ${detail}`);
    }
    return envelope.data || {};
  };

  return {
    baseUrl: base,
    datasourceUid,
    proxyPath,
    search: () => request('/api/search', { type: 'dash-db', limit: 5000 }),
    dashboard: (uid) => request(`/api/dashboards/uid/${encodeURIComponent(uid)}`),
    annotations: ({ from, to, dashboardUid }) => request('/api/annotations', { from, to, dashboardUID: dashboardUid }),
    targets: async () => (await prometheus('targets', { state: 'active' })).activeTargets || [],
    queryRange: async ({ query, start, end, step }) => {
      const data = await prometheus('query_range', { query, start, end, step });
      return (data.result || []).map((series) => ({
        metric: series.metric || {},
        values: (series.values || []).map(([ts, value]) => [toNumber(ts), toNumber(value)]),
      }));
    },
    queryInstant: async ({ query, time }) => {
      const data = await prometheus('query', { query, time });
      return (data.result || []).map((series) => ({
        metric: series.metric || {},
        value: [toNumber(series.value[0]), toNumber(series.value[1])],
      }));
    },
  };
};

/** Fail fast when the configured datasource uid is not the one the priority-list dashboards query. */
const verifyDatasourceUid = (client, dashboards) => {
  const { flattenPanels } = require('./discovery');
  const seen = new Set();
  for (const doc of dashboards) {
    for (const panel of flattenPanels(doc.dashboard)) {
      if (panel.datasource && panel.datasource.uid) {
        seen.add(panel.datasource.uid);
      }
      for (const target of panel.targets || []) {
        if (target.datasource && target.datasource.uid) {
          seen.add(target.datasource.uid);
        }
      }
    }
  }
  if (seen.size && !seen.has(client.datasourceUid)) {
    throw new codes.ExitError(codes.CONFIG,
      `AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID is ${client.datasourceUid} `
      + `but the dashboards query ${[...seen].join(', ')}`,
      { configured: client.datasourceUid, dashboards: [...seen] });
  }
};

module.exports = { createGrafanaClient, verifyDatasourceUid, HttpError };
