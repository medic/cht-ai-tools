'use strict';
// Network egress (FR-083, revision 30): the destinations a run contacts are code plus the configured endpoints,
// printable for the platform's network policy (`agent-watchdog egress`) and enforced in process: every fetch of the
// run passes a guard that refuses any other destination before a connection is made. The platform policy is the
// enforcement of record for what the guard cannot see (the agent runtime's subprocess, the Slack SDK's transport).
const codes = require('../cli/exit-codes');

const REFERENCE_LINKS = 'resolving reference links that appeared in tool results';

/** Destinations every run contacts whatever the configuration. */
const FIXED_ENDPOINTS = Object.freeze([
  { host: 'slack.com', port: 443, purpose: 'Slack Web API: posting, threads, reactions, permalinks' },
  { host: 'files.slack.com', port: 443, purpose: 'Slack file upload URLs for the report share' },
  { host: 'api.anthropic.com', port: 443, purpose: 'the agent runtime\'s model calls' },
  { host: 'docs.communityhealthtoolkit.org', port: 443, purpose: REFERENCE_LINKS },
  { host: 'forum.communityhealthtoolkit.org', port: 443, purpose: REFERENCE_LINKS },
  { host: 'github.com', port: 443, purpose: `${REFERENCE_LINKS} (github.com/medic/ only)` },
]);

/** Destinations the configuration names; an endpoint left unset is left out. */
const CONFIGURED_ENDPOINTS = Object.freeze([
  {
    key: 'grafanaUrl', env: 'AGENT_WATCHDOG_GRAFANA_URL',
    purpose: 'dashboards, datasource proxy, targets, annotations, alert rules, link resolution',
  },
  { key: 'langfuseBaseUrl', env: 'LANGFUSE_BASE_URL', purpose: 'tracing' },
  { key: 'docsMcpUrl', env: 'AGENT_WATCHDOG_DOCS_MCP_URL', purpose: 'documentation search (the agent runtime)' },
  { key: 'specsUrl', env: 'AGENT_WATCHDOG_SPECS_URL', purpose: 'footer link resolution by the gate' },
  { key: 'configUrl', env: 'AGENT_WATCHDOG_CONFIG_URL', purpose: 'footer link resolution by the gate' },
]);

const EXEMPT = Object.freeze([{
  command: 'check',
  reason: 'contacts the CHT host the operator names; the platform policy refuses it inside the container',
}]);

const DEFAULT_PORTS = { 'https:': 443, 'http:': 80 };

/** The host and port a URL connects to, or null when it is not an http(s) URL. */
const originOf = (url) => {
  if (url === null || url === undefined) {
    return null;
  }
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(typeof url === 'string' ? url : (url.url || String(url)));
  } catch {
    return null;
  }
  const defaultPort = DEFAULT_PORTS[parsed.protocol];
  if (!defaultPort || !parsed.hostname) {
    return null;
  }
  return { host: parsed.hostname.toLowerCase(), port: parsed.port ? Number(parsed.port) : defaultPort };
};

const keyOf = (origin) => `${origin.host}:${origin.port}`;

/**
 * The allow-list: fixed destinations and configured endpoints, one entry per host and port, sorted by host, each with
 * the purposes it serves and where it comes from (`code` or the environment variable).
 */
const buildEgress = (config) => {
  const endpoints = (config && config.endpoints) || {};
  const byKey = new Map();
  const add = (origin, purpose, source) => {
    const key = keyOf(origin);
    if (!byKey.has(key)) {
      byKey.set(key, { host: origin.host, port: origin.port, purposes: [], sources: [] });
    }
    const entry = byKey.get(key);
    if (!entry.purposes.includes(purpose)) {
      entry.purposes.push(purpose);
    }
    if (!entry.sources.includes(source)) {
      entry.sources.push(source);
    }
  };
  for (const fixed of FIXED_ENDPOINTS) {
    add({ host: fixed.host, port: fixed.port }, fixed.purpose, 'code');
  }
  for (const configured of CONFIGURED_ENDPOINTS) {
    const origin = originOf(endpoints[configured.key]);
    if (origin) {
      add(origin, configured.purpose, configured.env);
    }
  }
  const sorted = [...byKey.values()].sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port);
  return { endpoints: sorted };
};

/** Whether a URL's host and port are on the list. Anything unparseable is not. */
const isEgressAllowed = (url, egress) => {
  const origin = originOf(url);
  if (!origin) {
    return false;
  }
  return ((egress && egress.endpoints) || []).some((e) => e.host === origin.host && e.port === origin.port);
};

/** A refused destination: the run fails closed as an unavailable source, naming host and port and never the URL. */
class EgressRefusedError extends codes.ExitError {
  constructor(origin) {
    const where = origin ? `${origin.host}:${origin.port}` : 'a destination that is not a URL';
    super(codes.UNAVAILABLE, `egress refused: ${where} is not in the allow-list (FR-083)`, origin
      ? { host: origin.host, port: origin.port }
      : { host: null, port: null });
    this.name = 'EgressRefusedError';
  }
}

const noop = { error() {}, warn() {}, info() {}, debug() {} };

/** A fetch that refuses any destination outside `egress` before calling `fetch`; the log names host and port only. */
const guardFetch = (fetch, egress, { logger = noop } = {}) => {
  const guarded = async (input, init) => {
    if (!isEgressAllowed(input, egress)) {
      const origin = originOf(input);
      logger.error('egress.refused', { host: origin ? origin.host : null, port: origin ? origin.port : null });
      throw new EgressRefusedError(origin);
    }
    return fetch(input, init);
  };
  guarded.egressGuard = true;
  return guarded;
};

/**
 * Guard a target's `fetch` (the global by default) for the duration of a run. Installing on a target already guarded
 * changes nothing; `uninstall` restores the original once and is safe to call again.
 */
const installEgressGuard = ({ egress, logger = noop, target = globalThis }) => {
  const current = target.fetch;
  if (current && current.egressGuard) {
    return { fetch: current, uninstall: () => {} };
  }
  const original = current;
  const guarded = guardFetch((input, init) => original(input, init), egress, { logger });
  target.fetch = guarded;
  let installed = true;
  return {
    fetch: guarded,
    uninstall: () => {
      if (installed) {
        target.fetch = original;
        installed = false;
      }
    },
  };
};

/** The egress as the platform reads it: the endpoints, no inbound port, the one exempt command, and what to know. */
const egressDocument = (config, { version = null } = {}) => ({
  package: '@medic/agent-watchdog',
  version,
  generated_from: 'the effective configuration: fixed destinations in code plus the configured endpoints',
  inbound: 'none',
  endpoints: buildEgress(config).endpoints,
  exempt: [...EXEMPT],
  notes: [
    'The platform network policy is the enforcement of record for everything in the container, the agent runtime\'s '
      + 'subprocess and the Slack SDK included; the process refuses its own requests outside this list as well '
      + '(exit 69).',
    'DNS is the one further egress the pod needs.',
    'The runtime\'s telemetry and update checks are disabled by the image environment.',
  ],
});

module.exports = {
  FIXED_ENDPOINTS, CONFIGURED_ENDPOINTS, EXEMPT, originOf, buildEgress, isEgressAllowed, EgressRefusedError, guardFetch,
  installEgressGuard, egressDocument,
};
