'use strict';
// The daily pipeline: purge, feedback, collect, analyze, agent, rollup, render, publish (contracts/cli.md).
// Owns the run's state machine (data-model.md "Run") and the loud-failure rules (constitution V).
const codes = require('../exit-codes');
const { withEgressGuard } = require('../../net/egress');
const { redactText } = require('../../publish/redact');
const { loadConfig } = require('../../config/load');
const { RunDir, RunExistsError, ensureDataLayout } = require('../../store/run-dir');
const { collectVersions } = require('../../store/versions');
const { createContext } = require('../context');
const { STAGE_ORDER, loadStage, requireInputs } = require('../stages');
const { writeResult } = require('../streams');
const { createTracer } = require('../../trace/langfuse');
const { createFindingsGate } = require('../gate');
const { createQueryWindow } = require('../../collect/query-window');
const { activeWindow } = require('../../analyze/calendar');
const { metricSpecFor } = require('../../collect/windows');
const { appendOutcomes } = require('../../corpus/outcomes');
const { readMemory } = require('../../rollup/memory');
const { previousItemCounts } = require('../../rollup/history');
const { loadPatternCards } = require('../../corpus/cards');
const { scanRunArtefacts } = require('../../verify/scan');
const pkg = require('../../../package.json');

const todayUtc = (now) => now.toISOString().slice(0, 10);

const STATUS_AFTER_STAGE = { collect: 'collected', analyze: 'analysed', agent: 'drafted', render: 'rendered' };

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

// One agent definition, two faces (FR-050): the SDK engine in production, `claude -p` when
// AGENT_WATCHDOG_ENGINE=cli or --engine cli is given. Both take the same definition and MCP configuration.
const createEngineSafely = ({ config, definition, env, logger, runDir = null }) => {
  if (!definition) {
    return null;
  }
  try {
    const mcpConfig = definition.renderMcpConfig ? definition.renderMcpConfig(env) : { mcpServers: {} };
    if (config.model.engine === 'cli') {
      const { createCliEngine } = require('../../agent/engine-cli');
      return createCliEngine({ config, definition, mcpConfig, env, logger, runDir });
    }
    const { createSdkEngine } = require('../../agent/engine-sdk');
    return createSdkEngine({ config, definition, mcpConfig, env, logger });
  } catch (error) {
    logger.warn('agent.engine_unavailable', { error: error.message });
    return null;
  }
};

const resolveFindingsGate = ({ deps, gateModule, runDir, config, knownCards = [] }) => {
  if (typeof deps.gate === 'function') {
    return deps.gate;
  }
  if (!gateModule) {
    return null;
  }
  return createFindingsGate({ gateModule, runDir, config, fetch: deps.fetch || globalThis.fetch, knownCards });
};

// Merged pattern cards (FR-038): their ids are what the gate accepts in `pattern_card`, and the agent stage
// serves their text through read_pattern_card. A malformed card file is logged and treated as no cards.
const loadPatternCardsSafely = (config, logger) => {
  try {
    return loadPatternCards({ skillDir: config.paths.skillDir });
  } catch (error) {
    logger.warn('agent.pattern_cards_unavailable', { error: error.message });
    return { all: [], merged: [], index: [], get: () => null, byMetric: () => [], read: async () => '' };
  }
};

const createGrafanaSafely = (config, fetch, logger) => {
  try {
    const { createGrafanaClient } = require('../../collect/grafana');
    return createGrafanaClient({
      baseUrl: config.endpoints.grafanaUrl,
      token: config.secrets.grafanaToken,
      datasourceUid: config.endpoints.prometheusDatasourceUid,
      timeoutMs: config.bounds.httpTimeoutMs,
      queryTimeoutMs: config.bounds.queryTimeoutMs,
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
    return runDir.readJson('discovery.json').then(async (discovery) => createResolver({
      fetch: deps.fetch || globalThis.fetch,
      timeoutMs: config.bounds.httpTimeoutMs,
      discovery,
      grafanaUrl: config.endpoints.grafanaUrl,
      allowlist,
      // Alert-list links resolve against the collected rules and instances (FR-070).
      alerts: runDir.exists('alerts.json') ? await runDir.readJson('alerts.json') : null,
    }));
  } catch {
    return Promise.resolve(null);
  }
};

/** Put the ingested feedback on the context: items, horizons, unmatched notes, brief reactions and authors. */
const loadFeedbackContext = async (ctx, runDir) => {
  const ingested = await runDir.readJson('feedback.ingested.json');
  ctx.feedbackByItem = new Map(Object.entries(ingested.by_item || {}));
  ctx.feedbackHorizons = ingested.horizons || [];
  ctx.feedbackUnmatched = ingested.unmatched || [];
  ctx.feedbackBrief = ingested.brief || null;
  // Slack user ids of everyone who reacted or wrote a note, so proposals can mask them (FR-033).
  ctx.feedbackAuthors = [...new Set((ingested.records || []).map((record) => record.author).filter(Boolean))];
  ctx.feedbackIngested = ingested;
  return ingested;
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

/**
 * Open or create the run directory. A single stage reuses the latest run of the date and, when none exists yet,
 * creates it, so a contributor can start with `--stage collect` on an empty volume (FR-043, quickstart step 4).
 */
const openRunDir = async ({ dataDir, date, flags, stageOnly }) => {
  if (stageOnly) {
    const ids = (await RunDir.list(dataDir)).filter((id) => id.startsWith(date));
    if (ids.length) {
      return { runDir: RunDir.open(dataDir, ids[ids.length - 1]), supersedes: null, created: false };
    }
    return { runDir: await RunDir.create(dataDir, date), supersedes: null, created: true };
  }
  try {
    return { runDir: await RunDir.create(dataDir, date), supersedes: null, created: true };
  } catch (error) {
    if (!(error instanceof RunExistsError) || !flags.force) {
      throw error;
    }
    const ids = (await RunDir.list(dataDir)).filter((id) => id.startsWith(date));
    const supersedes = ids[ids.length - 1];
    const forcedId = await RunDir.nextForcedId(dataDir, date);
    const runDir = await RunDir.create(dataDir, forcedId);
    await RunDir.open(dataDir, supersedes).updateRun({ superseded_by: forcedId });
    return { runDir, supersedes, created: true };
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
  const loaded = loadConfig({ env, flags, command: 'run' });
  // FR-083: for the run's duration every fetch of this process, the stages' and any library's through the global,
  // passes the egress guard; a destination outside the allow-list is refused before a connection is made.
  return withEgressGuard({ config: loaded.config, logger, deps }, (guarded) => runLoaded({
    flags, env, stdout, logger, deps: guarded,
  }, loaded));
};

const runLoaded = async ({ flags, env, stdout, logger, deps }, { config, effective, policy }) => {
  const now = deps.now ? deps.now() : new Date();
  const date = flags.date || todayUtc(now);
  const stageOnly = flags.stage || null;
  const mode = runMode(config.behaviour.dryRun, stageOnly);
  const dataDir = config.storage.dataDir;
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();

  await ensureDataLayout(dataDir);
  const { runDir, supersedes, created } = await openRunDir({ dataDir, date, flags, stageOnly });
  const runId = runDir.runId;
  const log = logger.child({ run_id: runId });

  const tracer = deps.tracer || createTracer({ config });
  await tracer.start({ runId, date, mode });
  const traceUrl = await tracer.traceUrl();

  if (created) {
    await runDir.writeJson('config.effective.json', effective);
    await runDir.updateRun({
      run_id: runId,
      date,
      mode,
      status: 'created',
      started_at: startedAt,
      finished_at: null,
      duration_ms: null,
      versions: collectVersions({ pkg, config, env, policy, deps }),
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
  }
  if (stageOnly) {
    const existing = await runDir.readRun();
    await runDir.updateRun({ stage_runs: [...(existing.stage_runs || []), { stage: stageOnly, mode, at: startedAt }] });
  }

  const gateModule = typeof deps.gate === 'object' && deps.gate ? deps.gate : lazy({}, 'gate', '../../verify/gate');
  const links = lazy(deps, 'links', '../../links/build');
  const definition = deps.definition || loadDefinitionSafely(config, env, log);
  const engine = deps.engine || createEngineSafely({ config, definition, env, logger: log, runDir });
  const runStart = new Date(`${date}T06:00:00Z`);
  const grafana = deps.grafana || createGrafanaSafely(config, deps.fetch, log);
  const patternCards = deps.patternCards || loadPatternCardsSafely(config, log);
  const findingsGate = resolveFindingsGate({ deps, gateModule, runDir, config, knownCards: patternCards.index });
  // The model's live metric tool scopes and resolves expressions from the discovery this run wrote (FR-071).
  const specFor = async (metric) => (runDir.exists('discovery.json')
    ? metricSpecFor(await runDir.readJson('discovery.json'))(metric)
    : null);
  const queryWindow = deps.queryWindow || (grafana ? createQueryWindow({
    grafana, runStart, specFor,
    // The project's active expected-load window makes previous_cycle a known window (revision 34).
    activeWindowFor: (project) => activeWindow([], project, runStart),
  }) : null);
  const ctx = createContext({
    config, effective, policy, logger: log, runDir, runId, date, mode, tracer, engine, flags,
  });
  // Stages read shared dependencies from ctx.deps; tests inject fakes, production gets the real modules.
  // The agent stage calls ctx.deps.gate as a function; the roll-up uses ctx.gate.verifyBrief on the module.
  ctx.deps = {
    ...deps, gate: findingsGate, gateModule, links, engine, definition, grafana, queryWindow, patternCards,
  };
  ctx.gate = gateModule;
  ctx.links = links;
  ctx.definition = definition;
  ctx.runStart = runStart;
  // The wall clock (injectable): alerts are a live snapshot, so their ages and episodes are measured from it, not
  // from the analysed date, which lags it on a forced re-run (revision 16).
  ctx.now = now;
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
      if ((name === 'analyze' || name === 'rollup') && !ctx.feedbackByItem && runDir.exists('feedback.ingested.json')) {
        await loadFeedbackContext(ctx, runDir);
      }
      if (name === 'rollup') {
        ctx.memory = (await readMemory(dataDir)).text;
        ctx.previousItemIds = await previousItemCounts(dataDir, runId);
        // A stage-only roll-up (FR-043) still resolves links and carries the agent's recorded spend (revision 34):
        // the resolver is built from the discovery on disk, the cost read from agent.summary.json.
        if (!ctx.resolveLinks && runDir.exists('discovery.json')) {
          ctx.resolveLinks = await createResolverSafely({ config, deps, runDir, allowlist: ctx.allowlist });
        }
        if (!agentResult && runDir.exists('agent.summary.json')) {
          const summary = await runDir.readJson('agent.summary.json');
          ctx.costSoFar = Number(((ctx.costSoFar || 0) + (summary.cost_usd || 0)).toFixed(6));
          ctx.costEstimated = Boolean(ctx.costEstimated || summary.cost_estimated);
        }
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
        ctx.costSoFar = Number(((ctx.costSoFar || 0) + (result.cost_usd || 0)).toFixed(6));
        ctx.costEstimated = Boolean(ctx.costEstimated || result.cost_estimated);
      }
      if (name === 'feedback' && runDir.exists('feedback.ingested.json')) {
        const ingested = await loadFeedbackContext(ctx, runDir);
        // Outcomes are appended for the items whose feedback changed this run (revision 34), never re-appended
        // for every verdict still inside the influence window.
        const fresh = new Set((ingested.records || []).map((record) => record.item_id).filter(Boolean));
        const { appended } = await appendOutcomes({
          dataDir, date, runId, byItem: ingested.by_item || {}, itemIds: fresh,
        });
        log.info('corpus.outcomes', { appended, items: ctx.feedbackByItem.size });
        // The feedback stage's own model calls, the horizon parses and the reviews, are part of the run's cost.
        const feedbackCost = [...(ingested.calls || []), ...((ingested.review && ingested.review.calls) || [])]
          .reduce((sum, call) => sum + (call.cost_usd || 0), 0);
        ctx.costSoFar = Number(((ctx.costSoFar || 0) + feedbackCost).toFixed(6));
      }
      if (name === 'collect' && runDir.exists('discovery.json')) {
        ctx.resolveLinks = await createResolverSafely({ config, deps, runDir, allowlist: ctx.allowlist });
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
    // A single-stage run marks only its stage: the run's status belongs to the full pipeline (FR-043), and a
    // contributor re-running one stage sees the exit code and the log rather than a channel notice.
    const failurePatch = {
      finished_at: new Date().toISOString(),
      duration_ms: Number(process.hrtime.bigint() - startHr) / 1e6,
    };
    if (!stageOnly) {
      failurePatch.status = status;
    }
    await runDir.updateRun(failurePatch);
    log.error('run.failed', { stage: currentStage, status: stageOnly ? 'stage' : status, error });
    if (!unposted && mode !== 'preview' && !stageOnly) {
      const notifier = failureNotifier(config, log, deps);
      if (notifier) {
        try {
          // The error message is code text outside the gate; it is redacted before it is posted (FR-024, revision 27).
          await notifier.postFailureNotice({
            text: `agent-watchdog run ${runId} failed at stage ${currentStage || 'setup'}: `
              + redactText(error.message),
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
    patch.cost_estimated = Boolean(ctx.costEstimated);
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
  // SC-010: every artefact the run wrote is scanned for secret and personal-data shapes. A finding is flagged with
  // its file, line and pattern (never the value) for the operator; the run itself is not failed for it
  // (constitution VI: flag, do not act).
  const scanFindings = scanRunArtefacts(runDir.root);
  // Findings in what the run wrote are the ones it is answerable for; findings in reference text it was given are
  // reported apart, so a clean run shows none of its own (FR-016, revision 19).
  const ownFindings = scanFindings.filter((f) => !f.reference);
  const referenceFindings = scanFindings.filter((f) => f.reference);
  if (scanFindings.length) {
    log.warn('run.scan_findings', {
      count: ownFindings.length,
      reference_count: referenceFindings.length,
      findings: ownFindings.slice(0, 20),
      reference_findings: referenceFindings.slice(0, 20),
    });
  }
  try {
    await tracer.finish({ output: { status: status || 'stage', cost_usd: ctx.costSoFar } });
  } catch (traceError) {
    // Tracing is observability, not the product: a rejected flush is logged and never changes the exit code.
    log.warn('trace.finish_failed', { error: traceError });
  }
  log.info('run.finish', {
    status: status || 'stage', duration_ms: patch.duration_ms, cost_usd: ctx.costSoFar,
    scan_findings: ownFindings.length,
    scan_findings_reference: referenceFindings.length,
  });

  if (mode === 'preview' && publishResult && publishResult.payload) {
    writeResult(stdout, publishResult.payload);
  }
  return codes.OK;
};

module.exports.runLoaded = runLoaded;
