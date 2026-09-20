'use strict';
// `agent-watchdog check <cht-url>` (FR-048, contracts/cli.md): readiness of one CHT deployment, reported in plain
// language on stdout. Exit 0 when every prerequisite is met, 1 when any is unmet, 69 when the deployment is
// unreachable, 64 for a missing or malformed URL. Needs no Grafana, Slack, model or tracing configuration.
const codes = require('../exit-codes');
const { loadConfig } = require('../../config/load');
const { normaliseHost } = require('../../config/policy');
const { writeResult } = require('../streams');
const { checkReadiness, renderReport } = require('../../readiness/check');

const USAGE = 'usage: agent-watchdog check <cht-url>';

/** Accept `https://host`, `http://host/path` or a bare host; anything else is a usage error. */
const parseTarget = (positionals) => {
  const raw = positionals && positionals[0] ? String(positionals[0]).trim() : '';
  if (!raw) {
    throw new codes.ExitError(codes.USAGE, `${USAGE}: the CHT URL is required`);
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new codes.ExitError(codes.USAGE, `${USAGE}: "${raw}" is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || /\s/.test(raw)) {
    throw new codes.ExitError(codes.USAGE, `${USAGE}: "${raw}" is not an http(s) URL`);
  }
  return parsed;
};

module.exports = async function check({
  positionals = [], flags = {}, env = process.env, stdout = process.stdout, logger, deps = {},
}) {
  const target = parseTarget(positionals);
  const { config, policy } = loadConfig({ env, flags, command: 'check' });
  const host = normaliseHost(target.host);
  const annotation = (policy && policy.projects && policy.projects.projects[host]) || null;
  const hostMetrics = Boolean(annotation && annotation.host_metrics === true);

  const report = await checkReadiness({
    url: `https://${target.host}`,
    fetch: deps.fetch || globalThis.fetch,
    timeoutMs: config.bounds.httpTimeoutMs,
    hostMetrics,
    now: deps.now,
  });
  if (logger) {
    logger.info('readiness.checked', {
      host: report.host,
      app: report.version ? report.version.app : null,
      ready: report.ready,
      host_metrics_probed: hostMetrics,
      unmet: report.checks.filter((c) => c.status === 'unmet').map((c) => c.name),
    });
  }
  writeResult(stdout, renderReport(report));
  return report.ready ? codes.OK : codes.FAILED;
};

module.exports.parseTarget = parseTarget;
