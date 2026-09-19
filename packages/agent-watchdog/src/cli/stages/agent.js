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
  const projects = asArray(discovery, 'projects');
  const dataDir = ctx.config.storage.dataDir;
  const memoryFile = dataPaths(dataDir).memoryFile;
  const memory = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, 'utf8') : '';
  const feedbackFile = 'feedback.ingested.json';
  const feedbackAll = ctx.runDir.exists(feedbackFile) ? await ctx.runDir.readJson(feedbackFile) : null;
  const deadline = ctx.deadline || Date.now() + ctx.config.bounds.runTimeoutMs;
  const patternCards = deps.patternCards || { index: [], read: async () => '' };
  const concurrency = Math.max(1, ctx.config.bounds.projectConcurrency || 1);

  const results = new Array(projects.length).fill(null);
  const skipped = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < projects.length) {
      const index = cursor;
      cursor += 1;
      const project = projects[index];
      const candidates = await readIfExists(ctx.runDir, `${project.slug}/candidates.json`, 'candidates');
      if (!candidates.length) {
        logger.info('agent.skip', { project_url: project.url, reason: 'no candidates' });
        skipped.push(project.url);
        continue;
      }
      const changes = await readIfExists(ctx.runDir, `${project.slug}/changes.json`, 'changes');
      const getWindows = async (p, metric) => {
        const rel = `${p.slug}/inputs/windows.json.gz`;
        const windows = p.slug && ctx.runDir.exists(rel) ? asArray(await ctx.runDir.readGz(rel), 'windows') : [];
        return {
          windows: windows.filter((w) => w.metric === metric),
          change: changes.find((c) => c.metric === metric) || null,
        };
      };
      const localTools = createWatchdogTools({
        deps: {
          getWindows,
          queryWindow: deps.queryWindow || unavailableQuery,
          itemHistory: deps.itemHistory || itemHistoryFor(dataDir, ctx.runId, project.slug),
          metrics: changes.map((c) => c.metric),
        },
        project,
        discovery,
        patternCards,
        recorder: () => {},
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
        mcpConfig,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, projects.length || 1) }, worker));

  const analysed = projects.filter((p, i) => results[i]).map((p) => p.url);
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

module.exports = { name, inputs, run, asArray, feedbackFor, activeWindowFrom, itemHistoryFor };
