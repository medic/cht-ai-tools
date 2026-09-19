'use strict';
// The daily pipeline: purge, feedback, collect, analyze, agent, rollup, render, publish (contracts/cli.md).
// Owns the run's state machine (data-model.md "Run") and the loud-failure rules (constitution V).
const { execFileSync } = require('node:child_process');
const codes = require('../exit-codes');
const { loadConfig } = require('../../config/load');
const { RunDir, RunExistsError, ensureDataLayout } = require('../../store/run-dir');
const { createContext } = require('../context');
const { STAGE_ORDER, loadStage, requireInputs } = require('../stages');
const { writeResult } = require('../streams');
const { createTracer } = require('../../trace/langfuse');
const { createFindingsGate } = require('../gate');
const { createQueryWindow } = require('../../collect/query-window');
const { appendOutcomes } = require('../../corpus/outcomes');
const { readMemory } = require('../../rollup/memory');
const { previousItemCounts } = require('../../rollup/history');
const pkg = require('../../../package.json');

const todayUtc = (now) => now.toISOString().slice(0, 10);

const STATUS_AFTER_STAGE = { collect: 'collected', analyze: 'analysed', agent: 'drafted', render: 'rendered' };

const resolveGitSha = (deps) => {
  if (deps.gitSha) {
    return deps.gitSha;
  }
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().trim();
  } catch {
    return null;
  }
};

const definitionHashes = (config, env, deps) => {
  if (deps.definitionHashes) {
    return deps.definitionHashes;
  }
  try {
    const { loadDefinition } = require('../../agent/definition');
    return loadDefinition({ paths: config.paths, env, config }).hashes;
  } catch {
    return { prompts_hash: null, skill_hash: null, schema_hash: null };
  }
};

const lazy = (deps, key, modulePath) => {
  if (deps[key]) {
    return deps[key];
  }
  try {
    return require(modulePath);
  } catch {
    return null;
  }
};

const loadDefinitionSafely = (config, env, logger) => {
  try {
    const { loadDefinition } = require('../../agent/definition');
    return loadDefinition({ paths: config.paths, env, config });
  } catch (error) {
    logger.warn('agent.definition_unavailable', { error: error.message });
    return null;
  }
};

const createEngineSafely = ({ config, definition, env, logger }) => {
  if (!definition) {
    return null;
  }
  try {
    const { createSdkEngine } = require('../../agent/engine-sdk');
    const mcpConfig = definition.renderMcpConfig ? definition.renderMcpConfig(env) : { mcpServers: {} };
    return createSdkEngine({ config, definition, mcpConfig, env, logger });
  } catch (error) {
    logger.warn('agent.engine_unavailable', { error: error.message });
    return null;
  }
};

const resolveFindingsGate = ({ deps, gateModule, runDir, config }) => {
  if (typeof deps.gate === 'function') {
    return deps.gate;
  }
  if (!gateModule) {
    return null;
  }
  return createFindingsGate({ gateModule, runDir, config, fetch: deps.fetch || globalThis.fetch });
};

const createGrafanaSafely = (config, fetch, logger) => {
  try {
    const { createGrafanaClient } = require('../../collect/grafana');
    return createGrafanaClient({
      baseUrl: config.endpoints.grafanaUrl,
      token: config.secrets.grafanaToken,
      datasourceUid: config.endpoints.prometheusDatasourceUid,
      timeoutMs: config.bounds.httpTimeoutMs,
      fetch: fetch || globalThis.fetch,
      logger,
    });
  } catch (error) {
    logger.warn('collect.grafana_unavailable', { error: error.message });
    return null;
  }
};

const buildAllowlistSafely = (config) => {
  try {
    return require('../../links/allowlist').buildAllowlist(config);
  } catch {
    return [];
  }
};

const supersededPermalinkFor = async (dataDir, supersedes) => {
  if (!supersedes) {
    return null;
  }
  try {
    const previous = RunDir.open(dataDir, supersedes);
    if (!previous.exists('rollup/publication.json')) {
      return null;
    }
    const publication = await previous.readJson('rollup/publication.json');
    return publication.permalink || null;
  } catch {
    return null;
  }
};

const createResolverSafely = ({ config, deps, runDir, allowlist }) => {
  try {
    const { createResolver } = require('../../links/resolve');
    return runDir.readJson('discovery.json').then((discovery) => createResolver({
      fetch: deps.fetch || globalThis.fetch,
      timeoutMs: config.bounds.httpTimeoutMs,
      discovery,
      grafanaUrl: config.endpoints.grafanaUrl,
      allowlist,
    }));
  } catch {
    return Promise.resolve(null);
  }
};

const activeWindowsFrom = async (runDir) => {
  if (!runDir.exists('discovery.json')) {
    return {};
  }
  const discovery = await runDir.readJson('discovery.json');
  const result = {};
  for (const project of discovery.projects || []) {
    const rel = `${project.slug}/changes.json`;
    if (runDir.exists(rel)) {
      const changes = await runDir.readJson(rel);
      const active = changes.find((c) => c.expected_load_window_id);
      result[project.slug] = active ? active.expected_load_window_id : null;
    }
  }
  return result;
};

const failureNotifier = (config, logger, deps) => {
  if (deps.slackPublisher) {
    return deps.slackPublisher;
  }
  try {
    const { createSlackPublisher } = require('../../publish/slack');
    const client = deps.slack || new (require('@slack/web-api').WebClient)(config.secrets.slackBotToken);
    return createSlackPublisher({ client, channel: config.endpoints.slackChannelId, logger });
  } catch {
    return null;
  }
};

const openRunDir = async ({ dataDir, date, flags, stageOnly }) => {
  if (stageOnly) {
    const ids = (await RunDir.list(dataDir)).filter((id) => id.startsWith(date));
    if (!ids.length) {
      throw new codes.ExitError(codes.DATAERR, `no run for ${date} exists to run stage "${stageOnly}" on`);
    }
    return { runDir: RunDir.open(dataDir, ids[ids.length - 1]), supersedes: null };
  }
  try {
    return { runDir: await RunDir.create(dataDir, date), supersedes: null };
  } catch (error) {
    if (!(error instanceof RunExistsError) || !flags.force) {
      throw error;
    }
    const ids = (await RunDir.list(dataDir)).filter((id) => id.startsWith(date));
    const supersedes = ids[ids.length - 1];
    const forcedId = await RunDir.nextForcedId(dataDir, date);
    const runDir = await RunDir.create(dataDir, forcedId);
    await RunDir.open(dataDir, supersedes).updateRun({ superseded_by: forcedId });
    return { runDir, supersedes };
  }
};

const runMode = (dryRun, stageOnly) => {
  if (dryRun) {
    return 'preview';
  }
  return stageOnly ? 'stage' : 'scheduled';
};

const finalStatus = ({ mode, rollupResult }) => {
  if (mode === 'preview') {
    return 'previewed';
  }
  if (rollupResult && rollupResult.kind === 'heartbeat') {
    return 'heartbeat';
  }
  if (rollupResult && (rollupResult.degraded || rollupResult.kind === 'degraded')) {
    return 'degraded';
  }
  return 'published';
};

/**
 * Run the daily pipeline. Returns the exit code (0) or throws an ExitError / error mapped by the CLI.
 */
module.exports = async function run({ flags = {}, env = process.env, stdout = process.stdout, logger, deps = {} }) {
  const { config, effective, policy } = loadConfig({ env, flags, command: 'run' });
  const now = deps.now ? deps.now() : new Date();
  const date = flags.date || todayUtc(now);
  const stageOnly = flags.stage || null;
  const mode = runMode(config.behaviour.dryRun, stageOnly);
  const dataDir = config.storage.dataDir;
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();

  await ensureDataLayout(dataDir);
  const { runDir, supersedes } = await openRunDir({ dataDir, date, flags, stageOnly });
  const runId = runDir.runId;
  const log = logger.child({ run_id: runId });

  const tracer = deps.tracer || createTracer({ config });
  await tracer.start({ runId, date, mode });
  const traceUrl = await tracer.traceUrl();

  if (!stageOnly) {
    await runDir.writeJson('config.effective.json', effective);
    await runDir.updateRun({
      run_id: runId,
      date,
      mode,
      status: 'created',
      started_at: startedAt,
      finished_at: null,
      duration_ms: null,
      versions: {
        package: pkg.version,
        git_sha: resolveGitSha(deps),
        ...definitionHashes(config, env, deps),
        config_hash: policy.hash,
      },
      config_effective_path: 'config.effective.json',
      stages: [],
      projects: [],
      usage: null,
      cost_usd: null,
      publications: [],
      trace_id: tracer.traceId || null,
      trace_url: traceUrl,
      supersedes,
      superseded_by: null,
      bounds_hit: [],
    });
  } else {
    const existing = await runDir.readRun();
    await runDir.updateRun({ stage_runs: [...(existing.stage_runs || []), { stage: stageOnly, mode, at: startedAt }] });
  }

  const gateModule = typeof deps.gate === 'object' && deps.gate ? deps.gate : lazy({}, 'gate', '../../verify/gate');
  const links = lazy(deps, 'links', '../../links/build');
  const definition = deps.definition || loadDefinitionSafely(config, env, log);
  const engine = deps.engine || createEngineSafely({ config, definition, env, logger: log });
  const runStart = new Date(`${date}T06:00:00Z`);
  const grafana = deps.grafana || createGrafanaSafely(config, deps.fetch, log);
  const findingsGate = resolveFindingsGate({ deps, gateModule, runDir, config });
  const queryWindow = deps.queryWindow || (grafana ? createQueryWindow({ grafana, runStart }) : null);
  const ctx = createContext({
    config, effective, policy, logger: log, runDir, runId, date, mode, tracer, engine, flags,
  });
  // Stages read shared dependencies from ctx.deps; tests inject fakes, production gets the real modules.
  // The agent stage calls ctx.deps.gate as a function; the roll-up uses ctx.gate.verifyBrief on the module.
  ctx.deps = { ...deps, gate: findingsGate, gateModule, links, engine, definition, grafana, queryWindow };
  ctx.gate = gateModule;
  ctx.links = links;
  ctx.definition = definition;
  ctx.runStart = runStart;
  ctx.allowlist = buildAllowlistSafely(config);
  ctx.resolveLinks = null;
  ctx.supersededPermalink = await supersededPermalinkFor(dataDir, supersedes);
  ctx.deadline = Date.now() + config.bounds.runTimeoutMs;
  ctx.traceUrl = traceUrl;
  ctx.costSoFar = 0;
  ctx.supersedes = supersedes;

  const stageNames = stageOnly ? [stageOnly] : STAGE_ORDER;
  let currentStage = null;
  let rollupResult = null;
  let publishResult = null;
  let agentResult = null;

  log.info('run.start', { date, mode, stages: stageNames });
  try {
    for (const name of stageNames) {
      const stage = (deps.stages && deps.stages[name]) || loadStage(name);
      requireInputs(runDir, stage.inputs || []);
      currentStage = name;
      if (name === 'rollup') {
        ctx.memory = (await readMemory(dataDir)).text;
        ctx.previousItemIds = await previousItemCounts(dataDir, runId);
      }
      await runDir.stageStart(name);
      const stageCtx = ctx.forStage(name);
      stageCtx.logger.info('stage.start', {});
      const result = await tracer.stage(name, () => stage.run(stageCtx));
      await runDir.stageEnd(name, 'completed');
      stageCtx.logger.info('stage.end', { result: result && typeof result === 'object' ? result : { value: result } });
      currentStage = null;

      if (name === 'agent' && result) {
        agentResult = result;
        ctx.costSoFar = result.cost_usd || 0;
      }
      if (name === 'feedback' && runDir.exists('feedback.ingested.json')) {
        const ingested = await runDir.readJson('feedback.ingested.json');
        ctx.feedbackByItem = new Map(Object.entries(ingested.by_item || {}));
        ctx.feedbackHorizons = ingested.horizons || [];
        ctx.feedbackUnmatched = ingested.unmatched || [];
        ctx.feedbackBrief = ingested.brief || null;
        const { appended } = await appendOutcomes({ dataDir, date, runId, byItem: ingested.by_item || {} });
        log.info('corpus.outcomes', { appended, items: ctx.feedbackByItem.size });
      }
      if (name === 'collect' && runDir.exists('discovery.json')) {
        ctx.resolveLinks = await createResolverSafely({ config, deps, runDir, allowlist: ctx.allowlist });
      }
      if (name === 'analyze') {
        ctx.activeWindows = await activeWindowsFrom(runDir);
      }
      if (name === 'rollup') {
        rollupResult = result;
        const rollupCost = (result && Array.isArray(result.calls) ? result.calls : [])
          .reduce((sum, call) => sum + (call.cost_usd || 0), 0);
        ctx.costSoFar = Number((ctx.costSoFar + rollupCost).toFixed(6));
      }
      if (name === 'publish') {
        publishResult = result;
      }
      if (!stageOnly && STATUS_AFTER_STAGE[name]) {
        await runDir.updateRun({ status: STATUS_AFTER_STAGE[name] });
      }
      if (!stageOnly && name === 'rollup') {
        await runDir.updateRun({ status: result && result.degraded ? 'degraded' : 'verified' });
      }
    }
  } catch (error) {
    if (currentStage) {
      await runDir.stageEnd(currentStage, 'failed', { error: error.message });
    }
    const unposted = error.code === codes.IOERR;
    const status = unposted ? 'unposted' : 'failed';
    await runDir.updateRun({
      status,
      finished_at: new Date().toISOString(),
      duration_ms: Number(process.hrtime.bigint() - startHr) / 1e6,
    });
    log.error('run.failed', { stage: currentStage, status, error });
    if (!unposted && mode !== 'preview') {
      const notifier = failureNotifier(config, log, deps);
      if (notifier) {
        try {
          await notifier.postFailureNotice({
            text: `agent-watchdog run ${runId} failed at stage ${currentStage || 'setup'}: ${error.message}`,
            traceUrl,
            runId,
            date,
          });
        } catch (noticeError) {
          log.error('publish.failure_notice_failed', { error: noticeError });
        }
      }
    }
    try {
      await tracer.finish({ output: { status, error: error.message } });
    } catch (traceError) {
      log.warn('trace.finish_failed', { error: traceError });
    }
    throw error;
  }

  const status = stageOnly ? null : finalStatus({ mode, rollupResult });
  const patch = {
    finished_at: new Date().toISOString(),
    duration_ms: Number(process.hrtime.bigint() - startHr) / 1e6,
  };
  if (status) {
    patch.status = status;
  }
  if (agentResult) {
    patch.cost_usd = ctx.costSoFar;
    patch.usage = agentResult.usage || null;
    patch.bounds_hit = agentResult.bounds_hit || [];
  }
  if (publishResult && publishResult.posted) {
    const existing = await runDir.readRun();
    patch.publications = [...(existing.publications || []), {
      channel_id: config.endpoints.slackChannelId,
      ts: publishResult.ts,
      permalink: publishResult.permalink || null,
    }];
  }
  await runDir.updateRun(patch);
  await tracer.finish({ output: { status: status || 'stage', cost_usd: ctx.costSoFar } });
  log.info('run.finish', { status: status || 'stage', duration_ms: patch.duration_ms, cost_usd: ctx.costSoFar });

  if (mode === 'preview' && publishResult && publishResult.payload) {
    writeResult(stdout, publishResult.payload);
  }
  return codes.OK;
};
