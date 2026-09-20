'use strict';
// `agent-watchdog tools-server`: the enumerated read-only tools served over stdio to the `claude` command-line
// engine (contracts/agent-definition.md). Builds exactly what the agent stage gives the SDK engine in-process;
// under --replay every answer comes from the stored run's recordings and nothing external is contacted (FR-041).
// stdout belongs to the MCP transport, so logs go to stderr only.
const fs = require('node:fs');
const path = require('node:path');
const codes = require('../exit-codes');
const { loadConfig } = require('../../config/load');
const { createWatchdogTools } = require('../../agent/tools/watchdog-tools');
const { createRecordedTools } = require('../../agent/tools/recorded-tools');
const { createReplayLookup } = require('../../agent/tools/replay-shim');
const { serveStdio } = require('../../agent/tools/stdio-server');
const { asArray, itemHistoryFor } = require('../stages/agent');
const atomic = require('../../store/atomic');

const SERVERS = ['watchdog', 'cht-docs'];
const RECORDED_FILE = 'recorded-tool-calls.jsonl';

const unavailableQuery = async () => ({
  unavailable: true, reason: 'live metric queries need Grafana configuration (AGENT_WATCHDOG_GRAFANA_URL and token)',
});

const grafanaConfigured = (config) => Boolean(config && config.endpoints && config.endpoints.grafanaUrl
  && config.endpoints.prometheusDatasourceUid && config.secrets && config.secrets.grafanaToken);

const liveQueryWindow = ({ config, discovery, deps, logger }) => {
  const { createGrafanaClient } = require('../../collect/grafana');
  const { createQueryWindow } = require('../../collect/query-window');
  const { metricSpecFor } = require('../../collect/windows');
  const grafana = createGrafanaClient({
    baseUrl: config.endpoints.grafanaUrl,
    token: config.secrets.grafanaToken,
    datasourceUid: config.endpoints.prometheusDatasourceUid,
    timeoutMs: (config.bounds && config.bounds.httpTimeoutMs) || 15000,
    queryTimeoutMs: (config.bounds && config.bounds.queryTimeoutMs) || 30000,
    fetch: deps.fetch || globalThis.fetch,
    logger,
  });
  return createQueryWindow({ grafana, runStart: new Date(discovery.run_start), specFor: metricSpecFor(discovery) });
};

/**
 * Build the tool definitions for one server of one project session.
 * @param {object} options runRoot, dataDir, slug, server, replay, config, logger, deps
 */
const buildTools = async ({
  runRoot, dataDir, slug, server = 'watchdog', replay = false, config = null, logger, deps = {},
}) => {
  if (!SERVERS.includes(server)) {
    throw new codes.ExitError(codes.USAGE, `unknown server "${server}"; expected one of ${SERVERS.join(', ')}`);
  }
  if (server === 'cht-docs' && !replay) {
    throw new codes.ExitError(codes.USAGE, 'the cht-docs server is served from recordings only; pass --replay');
  }
  const discoveryFile = path.join(runRoot, 'discovery.json');
  if (!fs.existsSync(discoveryFile)) {
    throw new codes.ExitError(codes.DATAERR, `missing stage input: discovery.json under ${runRoot}`);
  }
  const discovery = await atomic.readJson(discoveryFile);
  const project = asArray(discovery, 'projects').find((p) => p.slug === slug) || { slug, host: slug, url: null };
  const recorder = deps.recorder || ((call) => logger.debug('tools.call', { server, tool: call.tool }));
  const recordedFile = path.join(runRoot, slug, RECORDED_FILE);
  const lookup = replay ? createReplayLookup(await atomic.readJsonl(recordedFile)) : null;

  if (server === 'cht-docs') {
    return createRecordedTools({ lookup: lookup.forServer('cht-docs'), recorder });
  }

  const changesFile = path.join(runRoot, slug, 'changes.json');
  const changes = fs.existsSync(changesFile) ? asArray(await atomic.readJson(changesFile), 'changes') : [];
  const getWindows = async (p, metric) => {
    const file = path.join(runRoot, p.slug || slug, 'inputs', 'windows.json.gz');
    const windows = fs.existsSync(file) ? asArray(await atomic.readGzipJson(file), 'windows') : [];
    return {
      windows: windows.filter((w) => w.metric === metric),
      change: changes.find((c) => c.metric === metric) || null,
    };
  };
  let queryWindow = deps.queryWindow || unavailableQuery;
  if (!deps.queryWindow && grafanaConfigured(config)) {
    queryWindow = liveQueryWindow({ config, discovery, deps, logger });
  }
  return createWatchdogTools({
    deps: {
      getWindows,
      queryWindow,
      itemHistory: deps.itemHistory || itemHistoryFor(dataDir, path.basename(runRoot), slug),
      metrics: changes.map((c) => c.metric),
    },
    project,
    discovery,
    patternCards: deps.patternCards || { index: [], read: async () => '' },
    replay: replay ? lookup.forServer('watchdog') : null,
    recorder,
  });
};

/** Command handler: validate, build, serve until the client closes the transport. */
module.exports = async function toolsServer({ flags = {}, env = process.env, logger, deps = {} }) {
  const runRoot = flags['run-dir'];
  const slug = Array.isArray(flags.project) ? flags.project[0] : flags.project;
  const server = flags.server || 'watchdog';
  if (!runRoot) {
    throw new codes.ExitError(codes.USAGE, 'tools-server requires --run-dir <path>');
  }
  if (!slug) {
    throw new codes.ExitError(codes.USAGE, 'tools-server requires --project <slug>');
  }
  if (!SERVERS.includes(server)) {
    throw new codes.ExitError(codes.USAGE, `unknown server "${server}"; expected one of ${SERVERS.join(', ')}`);
  }
  if (!fs.existsSync(runRoot)) {
    throw new codes.ExitError(codes.DATAERR, `run directory not found: ${runRoot}`);
  }
  if (!fs.existsSync(path.join(runRoot, slug))) {
    throw new codes.ExitError(codes.DATAERR, `project directory not found under the run: ${slug}`);
  }
  const { config } = loadConfig({ env, flags, command: 'tools-server', withPolicy: false });
  const log = logger.child ? logger.child({ command: 'tools-server', server, project: slug }) : logger;
  const tools = await buildTools({
    runRoot, dataDir: config.storage.dataDir, slug, server, replay: Boolean(flags.replay), config, logger: log, deps,
  });
  log.info('tools.serving', { tools: tools.map((t) => t.name), replay: Boolean(flags.replay) });
  await (deps.serve || serveStdio)({ name: server, tools });
  log.info('tools.closed', {});
  return codes.OK;
};

module.exports.buildTools = buildTools;
module.exports.SERVERS = SERVERS;
module.exports.RECORDED_FILE = RECORDED_FILE;
