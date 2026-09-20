'use strict';
// Grafana client: dashboards, search, annotations, the Prometheus datasource proxy (research.md R-5) and the
// Grafana-managed alerting endpoints (R-14).
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

const ALERT_RULES_PATH = '/api/prometheus/grafana/api/v1/rules';
const ALERT_INSTANCES_PATH = '/api/prometheus/grafana/api/v1/alerts';
const MAX_ALERT_PAGES = 100;

const toNumber = (value) => Number(value);
const DETAIL_MAX = 300;

/** What the response said, for the error message: Prometheus's `errorType: error`, Grafana's `message`, or text. */
const detailOf = (body) => {
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(body);
    const text = parsed && parsed.error
      ? `${parsed.errorType ? `${parsed.errorType}: ` : ''}${parsed.error}`
      : parsed && parsed.message;
    return text ? String(text).slice(0, DETAIL_MAX) : null;
  } catch {
    return String(body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX) || null;
  }
};

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
      const detail = detailOf(body);
      throw new HttpError(
        response.status, `Grafana returned ${response.status} for ${url.pathname}${detail ? `: ${detail}` : ''}`, body,
      );
    }
    return response.json();
  };

  // Grafana-managed alerting (research.md R-14): the rules endpoint pages with groupNextToken.
  const alertingEnvelope = async (pathname, params) => {
    const envelope = await request(pathname, params);
    if (!envelope || envelope.status !== 'success') {
      const type = (envelope && envelope.errorType) || 'error';
      const detail = (envelope && envelope.error) || 'unknown error';
      throw new Error(`Grafana alerting ${pathname} failed: ${type}: ${detail}`);
    }
    return envelope;
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
    /** Grafana-managed rules with their instances, every page followed; raw envelopes kept for the record. */
    alertRules: async ({ groupLimit = null } = {}) => {
      const groups = [];
      const raw = [];
      let token = null;
      let pages = 0;
      do {
        const params = {};
        if (groupLimit) {
          params.group_limit = groupLimit;
        }
        if (token) {
          params.group_next_token = token;
        }
        const envelope = await alertingEnvelope(ALERT_RULES_PATH, params);
        raw.push(envelope);
        pages += 1;
        const data = envelope.data || {};
        groups.push(...(data.groups || []));
        token = data.groupNextToken || null;
      } while (token && pages < MAX_ALERT_PAGES);
      return { groups, pages, raw };
    },
    /** Firing and pending instances alone, when the rules endpoint cannot be read. */
    alertInstances: async () => {
      const envelope = await alertingEnvelope(ALERT_INSTANCES_PATH);
      return (envelope.data && envelope.data.alerts) || [];
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

module.exports = { createGrafanaClient, verifyDatasourceUid, HttpError, ALERT_RULES_PATH, ALERT_INSTANCES_PATH };
