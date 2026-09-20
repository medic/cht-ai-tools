'use strict';
// Readiness check for a CHT deployment (FR-048, research.md R-6, contracts/cli.md "check"): the monitoring
// endpoint the watchdog scrapes, the minimum CHT version it needs, two informational version gates for the
// dashboards that stay empty on older releases, and the optional host-metrics exporter. Read-only, unauthenticated,
// bounded by a timeout; it never contacts Grafana or Slack.
const codes = require('../cli/exit-codes');
const { atLeast } = require('./version');

const MINIMUM_VERSION = '3.12.0';
const API_METRICS_VERSION = '4.3.0';
const COUCHDB_SIZE_VERSION = '4.11.0';
const HOST_METRICS_PORT = 8443;
const EXPORTER_MARKERS = ['container_', 'machine_'];

const monitoringUrl = (host) => `https://${host}/api/v2/monitoring`;
const hostMetricsUrl = (host) => `https://${host}:${HOST_METRICS_PORT}/metrics`;

const hostOf = (url) => {
  const parsed = new URL(url);
  return parsed.host.toLowerCase();
};

/** A plain-language reason for a failed request: timeout, connection error or HTTP status. */
const failureReason = (error) => {
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'the request timed out';
  }
  const cause = error && error.cause && (error.cause.code || error.cause.message);
  return `connection error (${cause || (error && error.message) || 'unknown'})`;
};

const request = async (fetch, url, timeoutMs) => fetch(url, {
  method: 'GET',
  headers: { Accept: 'application/json, text/plain' },
  redirect: 'follow',
  signal: AbortSignal.timeout(timeoutMs),
});

/** GET the monitoring document; any failure here means the deployment is unreachable for the watchdog (exit 69). */
const fetchMonitoring = async ({ fetch, host, timeoutMs }) => {
  const url = monitoringUrl(host);
  let response;
  try {
    response = await request(fetch, url, timeoutMs);
  } catch (error) {
    throw new codes.ExitError(codes.UNAVAILABLE, `monitoring endpoint unreachable: ${failureReason(error)} at ${url}`);
  }
  if (response.status < 200 || response.status >= 300) {
    const reason = `HTTP ${response.status} from ${url}`;
    throw new codes.ExitError(codes.UNAVAILABLE, `monitoring endpoint unreachable: ${reason}`);
  }
  const body = await response.text();
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    const reason = `the response from ${url} is not valid JSON`;
    throw new codes.ExitError(codes.UNAVAILABLE, `monitoring endpoint unreachable: ${reason}`);
  }
};

const versionOf = (monitoring) => {
  const version = monitoring && monitoring.version;
  if (!version || typeof version !== 'object' || typeof version.app !== 'string') {
    return null;
  }
  return {
    app: version.app,
    node: typeof version.node === 'string' ? version.node : null,
    couchdb: typeof version.couchdb === 'string' ? version.couchdb : null,
  };
};

const versionChecks = (version) => {
  const app = version ? version.app : null;
  const checks = [];
  if (app === null) {
    checks.push({
      name: 'minimum_version',
      status: 'unmet',
      message: `the CHT version could not be read from the monitoring endpoint (version.app is missing); `
        + `CHT ${MINIMUM_VERSION} or later is required`,
    });
  } else if (atLeast(app, MINIMUM_VERSION)) {
    checks.push({
      name: 'minimum_version',
      status: 'met',
      message: `CHT ${MINIMUM_VERSION} or later is required for the watchdog's monitoring API; `
        + `this instance runs ${app}`,
    });
  } else {
    checks.push({
      name: 'minimum_version',
      status: 'unmet',
      message: `CHT ${MINIMUM_VERSION} or later is required for the watchdog's monitoring API; `
        + `this instance runs ${app}`,
    });
  }
  const runs = app === null ? 'an unknown version' : app;
  checks.push(atLeast(app, API_METRICS_VERSION)
    ? {
      name: 'api_metrics',
      status: 'met',
      message: `CHT ${API_METRICS_VERSION} or later exposes API metrics (cht_api_*); this instance runs ${runs}`,
    }
    : {
      name: 'api_metrics',
      status: 'info',
      message: `CHT ${API_METRICS_VERSION} or later exposes API metrics (cht_api_*); this instance runs ${runs}, `
        + 'so the API Server and Replication dashboards will be empty',
    });
  checks.push(atLeast(app, COUCHDB_SIZE_VERSION)
    ? {
      name: 'couchdb_size_metrics',
      status: 'met',
      message: `CHT ${COUCHDB_SIZE_VERSION} or later exposes CouchDB size metrics; this instance runs ${runs}`,
    }
    : {
      name: 'couchdb_size_metrics',
      status: 'info',
      message: `CHT ${COUCHDB_SIZE_VERSION} or later exposes CouchDB size metrics (cht_couchdb_size_bytes, `
        + `view index sizes); this instance runs ${runs}, so the database size panels will be empty`,
    });
  return checks;
};

/** The optional cAdvisor probe: a failure here is an unmet prerequisite, the host itself already answered. */
const hostMetricsCheck = async ({ fetch, host, timeoutMs }) => {
  const url = hostMetricsUrl(host);
  const unmet = (reason) => ({
    name: 'host_metrics',
    status: 'unmet',
    message: `the host-metrics exporter (cAdvisor on port ${HOST_METRICS_PORT}) did not answer: ${reason}`,
  });
  let response;
  try {
    response = await request(fetch, url, timeoutMs);
  } catch (error) {
    return unmet(failureReason(error));
  }
  if (response.status < 200 || response.status >= 300) {
    return unmet(`HTTP ${response.status} from ${url}`);
  }
  const body = await response.text();
  if (!EXPORTER_MARKERS.some((marker) => body.includes(marker))) {
    return unmet(`${url} answered, but not with cAdvisor metrics`);
  }
  return {
    name: 'host_metrics',
    status: 'met',
    message: `the host-metrics exporter (cAdvisor on port ${HOST_METRICS_PORT}) answers at ${url}`,
  };
};

/**
 * @param {object} options
 * @param {string} options.url the CHT deployment URL (scheme and host; path ignored)
 * @param {Function} [options.fetch]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.hostMetrics] probe the cAdvisor exporter (projects.yaml `host_metrics: true`)
 * @param {Function} [options.now]
 */
const checkReadiness = async ({
  url, fetch = globalThis.fetch, timeoutMs = 15000, hostMetrics = false, now = () => new Date(),
}) => {
  const host = hostOf(url);
  const monitoring = await fetchMonitoring({ fetch, host, timeoutMs });
  const version = versionOf(monitoring);
  const checks = [{
    name: 'monitoring_endpoint',
    status: 'met',
    message: `monitoring endpoint ${monitoringUrl(host)} answers`,
  }, ...versionChecks(version)];
  if (hostMetrics) {
    checks.push(await hostMetricsCheck({ fetch, host, timeoutMs }));
  }
  return {
    url: `https://${host}`,
    host,
    reachable: true,
    version,
    checks,
    ready: checks.every((check) => check.status !== 'unmet'),
    checked_at: now().toISOString(),
  };
};

const LABELS = { met: 'met', unmet: 'UNMET', info: 'info', error: 'ERROR' };

/** The plain-language report printed on stdout. */
const renderReport = (report) => {
  const app = report.version && report.version.app ? report.version.app : 'unknown version';
  const lines = [`Readiness of ${report.host} (CHT ${app})`];
  for (const check of report.checks) {
    lines.push(`${(LABELS[check.status] || check.status).padEnd(6)}${check.message}`);
  }
  const unmet = report.checks.filter((check) => check.status === 'unmet').length;
  lines.push(report.ready ? 'ready' : `not ready: ${unmet} prerequisite${unmet === 1 ? '' : 's'} unmet`);
  return lines.join('\n');
};

module.exports = {
  checkReadiness, renderReport, monitoringUrl, hostMetricsUrl, versionChecks,
  MINIMUM_VERSION, API_METRICS_VERSION, COUCHDB_SIZE_VERSION, HOST_METRICS_PORT,
};
