'use strict';
// Stage: agent. One bounded session per project with candidates; projects without candidates cost nothing
// (FR-013). Reads discovery.json and each project's candidates.json and changes.json; writes the pass,
// verification, tool-call and session artefacts through the session loop (contracts/run-directory.md).
const fs = require('node:fs');
const path = require('node:path');
const { requireInputs } = require('./index');
const { loadDefinition } = require('../../agent/definition');
const { createSdkEngine } = require('../../agent/engine-sdk');
const { createWatchdogTools } = require('../../agent/tools/watchdog-tools');
const { createRecordedTools } = require('../../agent/tools/recorded-tools');
const { createReplayLookup } = require('../../agent/tools/replay-shim');
const { normaliseHost } = require('../../config/policy');
const { runProjectSession } = require('../../agent/session-loop');
const { RunDir, dataPaths } = require('../../store/run-dir');
const atomic = require('../../store/atomic');

const name = 'agent';
const inputs = ['discovery.json'];
const HISTORY_RUNS = 30;

const asArray = (doc, key) => {
  if (Array.isArray(doc)) {
    return doc;
  }
  if (doc && Array.isArray(doc[key])) {
    return doc[key];
  }
  return [];
};

const readIfExists = async (runDir, rel, key) => (runDir.exists(rel) ? asArray(await runDir.readJson(rel), key) : []);

const feedbackFor = (all, project) => {
  if (!all) {
    return [];
  }
  if (Array.isArray(all)) {
    return all.filter((f) => !f.project_url || f.project_url === project.url);
  }
  if (all.projects && all.projects[project.url]) {
    return all.projects[project.url];
  }
  return Array.isArray(all.items) ? all.items.filter((f) => f.project_url === project.url) : [];
};

const activeWindowFrom = (changes, discovery) => {
  const change = changes.find((c) => c.expected_load_window_id);
  if (!change) {
    return null;
  }
  const known = asArray(discovery, 'expected_load_windows').find((w) => w.id === change.expected_load_window_id);
  return known || { id: change.expected_load_window_id };
};

/** Past accepted items for an identity, with the feedback they received, from earlier runs on this volume. */
const itemHistoryFor = (dataDir, runId, slug) => async (projectUrl, metric, patternCard) => {
  const ids = (await RunDir.list(dataDir)).filter((id) => id !== runId).slice(-HISTORY_RUNS);
  const history = [];
  for (const id of ids) {
    const file = path.join(dataDir, 'runs', id, slug, 'passes.json');
    if (!fs.existsSync(file)) {
      continue;
    }
    const passes = asArray(await atomic.readJson(file), 'passes');
    const accepted = [...passes].reverse().find((p) => p.items && p.items.length);
    for (const item of (accepted ? accepted.items : [])) {
      if (item.metric === metric && (item.pattern_card || null) === (patternCard || null)) {
        history.push({
          run_id: id, item_id: item.item_id, severity: item.severity, confidence: item.confidence, feedback: [],
        });
      }
    }
  }
  const feedback = await atomic.readJsonl(dataPaths(dataDir).feedbackFile);
  for (const entry of history) {
    entry.feedback = feedback
      .filter((f) => f.item_id === entry.item_id)
      .map((f) => ({ verdict: f.verdict, note: f.note, author: f.author }));
  }
  return history;
};

const unavailableQuery = async () => ({
  unavailable: true, reason: 'live metric queries are not wired into this stage',
});

const isUnavailable = (result) => Boolean(result && typeof result === 'object' && result.unavailable === true);

/**
 * Replay (FR-041): every tool answers from the source run's recordings and nothing live is wired. `ctx.replay`
 * carries `recordedFor(slug)` (a replay lookup or null) and `onUnavailable(slug, call)` for unrecorded calls.
 */
const replayToolingFor = (ctx, slug) => {
  if (!ctx.replay) {
    return null;
  }
  const lookup = ctx.replay.recordedFor(slug) || createReplayLookup([]);
  const onUnavailable = typeof ctx.replay.onUnavailable === 'function' ? ctx.replay.onUnavailable : () => {};
  const recorder = (call) => {
    if (isUnavailable(call.result)) {
      onUnavailable(slug, call);
    }
  };
  return {
    watchdog: lookup.forServer('watchdog'),
    localServers: { 'cht-docs': createRecordedTools({ lookup: lookup.forServer('cht-docs'), recorder }) },
    recorder,
  };
};

const selectProjects = (projects, flags) => {
  const wanted = ((flags && flags.project) || []).map(normaliseHost);
  return wanted.length ? projects.filter((p) => wanted.includes(p.host)) : projects;
};

const run = async (ctx) => {
  requireInputs(ctx.runDir, inputs);
  const deps = ctx.deps || {};
  if (typeof deps.gate !== 'function') {
    throw new Error('agent stage requires a verification gate (ctx.deps.gate)');
  }
  const env = ctx.env || process.env;
  const logger = ctx.logger.child ? ctx.logger.child({ stage: name }) : ctx.logger;
  const definition = deps.definition || loadDefinition({ paths: ctx.config.paths, env });
  const mcpConfig = definition.renderMcpConfig(env);
  const engine = deps.engine || createSdkEngine({ config: ctx.config, definition, mcpConfig, env, logger });
  const discovery = await ctx.runDir.readJson('discovery.json');
  const projects = selectProjects(asArray(discovery, 'projects'), ctx.flags);
  const dataDir = ctx.config.storage.dataDir;
  const memoryFile = dataPaths(dataDir).memoryFile;
  const memory = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, 'utf8') : '';
  const feedbackFile = 'feedback.ingested.json';
  const feedbackAll = ctx.runDir.exists(feedbackFile) ? await ctx.runDir.readJson(feedbackFile) : null;
  const deadline = ctx.deadline || Date.now() + ctx.config.bounds.runTimeoutMs;
  const patternCards = deps.patternCards || { index: [], read: async () => '' };
  const concurrency = Math.max(1, ctx.config.bounds.projectConcurrency || 1);

  // Every project's inputs are read before any session starts, so a missing file refuses the whole stage
  // (FR-043) instead of surfacing after other projects have already spent model budget. A project with
  // candidates must also have its computed changes; they are never fabricated.
  const plan = [];
  const skipped = [];
  for (const project of projects) {
    const candidates = await readIfExists(ctx.runDir, `${project.slug}/candidates.json`, 'candidates');
    if (!candidates.length) {
      logger.info('agent.skip', { project_url: project.url, reason: 'no candidates' });
      skipped.push(project.url);
      continue;
    }
    const changesFile = `${project.slug}/changes.json`;
    requireInputs(ctx.runDir, [changesFile]);
    plan.push({ project, candidates, changes: asArray(await ctx.runDir.readJson(changesFile), 'changes') });
  }

  const results = new Array(plan.length).fill(null);
  let cursor = 0;

  const worker = async () => {
    while (cursor < plan.length) {
      const index = cursor;
      cursor += 1;
      const { project, candidates, changes } = plan[index];
      const getWindows = async (p, metric) => {
        const rel = `${p.slug}/inputs/windows.json.gz`;
        const windows = p.slug && ctx.runDir.exists(rel) ? asArray(await ctx.runDir.readGz(rel), 'windows') : [];
        return {
          windows: windows.filter((w) => w.metric === metric),
          change: changes.find((c) => c.metric === metric) || null,
        };
      };
      const replay = replayToolingFor(ctx, project.slug);
      const localTools = createWatchdogTools({
        deps: {
          getWindows,
          queryWindow: replay ? unavailableQuery : (deps.queryWindow || unavailableQuery),
          itemHistory: deps.itemHistory || itemHistoryFor(dataDir, ctx.runId, project.slug),
          metrics: changes.map((c) => c.metric),
        },
        project,
        discovery,
        patternCards,
        replay: replay ? replay.watchdog : null,
        recorder: replay ? replay.recorder : () => {},
      });
      logger.info('agent.session_start', { project_url: project.url, candidates: candidates.length });
      results[index] = await runProjectSession({
        engine, definition, project, candidates, changes,
        feedback: feedbackFor(feedbackAll, project),
        memory,
        activeWindow: activeWindowFrom(changes, discovery),
        config: ctx.config,
        gate: deps.gate,
        runDir: ctx.runDir,
        logger,
        tracer: ctx.tracer,
        deadline,
        localTools,
        localServers: replay ? replay.localServers : {},
        mcpConfig: replay ? { mcpServers: {} } : mcpConfig,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, plan.length || 1) }, worker));

  const analysed = plan.filter((p, i) => results[i]).map((p) => p.project.url);
  const summary = {
    projects_analysed: analysed,
    projects_skipped: skipped,
    items: results.filter(Boolean).flatMap((r) => r.items),
    bounds_hit: [...new Set(results.filter(Boolean).flatMap((r) => r.bounds_hit))],
    reference_sources_unavailable: results.some((r) => r && r.reference_sources_unavailable),
    cost_usd: Number(results.filter(Boolean).reduce((sum, r) => sum + (r.cost_usd || 0), 0).toFixed(6)),
    usage: results.filter(Boolean).reduce((total, r) => {
      for (const key of Object.keys(total)) {
        total[key] += (r.usage && r.usage[key]) || 0;
      }
      return total;
    }, { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }),
  };
  await ctx.runDir.writeJson('agent.summary.json', summary);
  logger.info('agent.done', {
    analysed: analysed.length, skipped: skipped.length, items: summary.items.length, cost_usd: summary.cost_usd,
    bounds_hit: summary.bounds_hit, reference_sources_unavailable: summary.reference_sources_unavailable,
  });
  return summary;
};

module.exports = { name, inputs, run, asArray, feedbackFor, activeWindowFrom, itemHistoryFor, selectProjects };
