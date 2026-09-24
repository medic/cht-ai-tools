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
const { runProjectSession } = require('../../agent/session-loop');
const { loadPatternCards } = require('../../corpus/cards');
const { RunDir, dataPaths } = require('../../store/run-dir');
const { analysedDatesBefore, runDate } = require('../../rollup/history');
const { splitStanding } = require('../../analyze/standing');
const { activeWindowOf } = require('../../analyze/calendar');
const atomic = require('../../store/atomic');
// `--project` and `--group` select the projects a run analyses (FR-066, revision 24); one helper for every stage.
const { selectProjects } = require('../../config/filter');

const name = 'agent';
const inputs = ['discovery.json'];
const HISTORY_RUNS = 30;
// No session opens with less than this to spend: below it a pass over a project's candidates cannot finish.
const MIN_SESSION_BUDGET_USD = 0.25;

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

/**
 * Past accepted items for an identity, with the feedback they received, from earlier analysed dates on this volume:
 * one entry per date, from the last run of that date, over the most recent dates strictly before this run's own
 * (revision 22). Earlier runs of the same date are attempts at this analysis, not history, so three forced re-runs
 * of one date no longer read back as three days of persistence. Oldest first, as before.
 */
const itemHistoryFor = (dataDir, runId, slug) => async (projectUrl, metric, patternCard) => {
  const dated = analysedDatesBefore(await RunDir.list(dataDir), runDate(runId)).slice(0, HISTORY_RUNS).reverse();
  const history = [];
  for (const [, id] of dated) {
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

/**
 * What a project's session is handed (FR-013, FR-014, revision 23): its candidates less the standing conditions,
 * which code names instead; a project with none left, or none at all, opens no session and the reason is named.
 */
const planFor = ({ candidates, changes }) => {
  if (!candidates.length) {
    return { forModel: [], standing: [], skipReason: 'no candidates' };
  }
  const { forModel, standing } = splitStanding({ candidates, changes });
  return { forModel, standing, skipReason: forModel.length ? null : 'standing conditions only' };
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
  // The project's firing alerts (FR-067), classified by code, reach the prompt as untrusted context.
  const alertsFile = 'alerts.classified.json';
  const classifiedAlerts = ctx.runDir.exists(alertsFile) ? await ctx.runDir.readJson(alertsFile) : null;
  const alertsFor = (project) => ((classifiedAlerts && classifiedAlerts.instances) || [])
    .filter((i) => i.state === 'firing' && i.project_url === project.url)
    .map((i) => ({
      title: i.title, category: i.category, importance: i.importance, started_at: i.started_at,
      days_firing: i.days_firing, stale: i.stale, new: i.new, value: i.value,
    }));
  const deadline = ctx.deadline || Date.now() + ctx.config.bounds.runTimeoutMs;
  const skillDir = ctx.config.paths && ctx.config.paths.skillDir;
  const patternCards = deps.patternCards
    || (skillDir ? loadPatternCards({ skillDir }) : { index: [], read: async () => '' });
  const concurrency = Math.max(1, ctx.config.bounds.projectConcurrency || 1);

  // Every project's inputs are read before any session starts, so a missing file refuses the whole stage
  // (FR-043) instead of surfacing after other projects have already spent model budget. A project with
  // candidates must also have its computed changes; they are never fabricated.
  const plan = [];
  const skipped = [];
  for (const project of projects) {
    const candidates = await readIfExists(ctx.runDir, `${project.slug}/candidates.json`, 'candidates');
    let changes = [];
    if (candidates.length) {
      const changesFile = `${project.slug}/changes.json`;
      requireInputs(ctx.runDir, [changesFile]);
      changes = asArray(await ctx.runDir.readJson(changesFile), 'changes');
    }
    const { forModel, standing, skipReason } = planFor({ project, candidates, changes });
    if (skipReason) {
      logger.info('agent.skip', { project_url: project.url, reason: skipReason, standing: standing.length });
      skipped.push(project.url);
      continue;
    }
    plan.push({ project, candidates: forModel, changes, standing: standing.length });
  }

  const results = new Array(plan.length).fill(null);
  let cursor = 0;

  // The run budget (AGENT_WATCHDOG_MAX_BUDGET_USD_RUN) is enforced here, across sessions: a session is granted at most
  // what the run has left after what finished sessions spent and what running ones may still spend, and no session
  // opens for less than MIN_SESSION_BUDGET_USD. Projects left out are named, so the brief can say so.
  const runBudget = ctx.config.bounds.maxBudgetUsdRun;
  const projectBudget = ctx.config.bounds.maxBudgetUsdProject;
  const round6 = (n) => Number(n.toFixed(6));
  let spent = 0;
  let reserved = 0;
  const notAnalysed = [];
  let budgetReached = false;

  const worker = async () => {
    while (cursor < plan.length) {
      const index = cursor;
      cursor += 1;
      const { project, candidates, changes } = plan[index];
      const remaining = runBudget === undefined || runBudget === null
        ? projectBudget
        : round6(runBudget - spent - reserved);
      if (remaining < MIN_SESSION_BUDGET_USD) {
        budgetReached = true;
        notAnalysed.push(project.url);
        logger.warn('agent.run_budget_reached', {
          project_url: project.url, run_budget_usd: runBudget, spent_usd: spent, not_analysed: notAnalysed.length,
        });
        continue;
      }
      const granted = round6(Math.min(projectBudget, remaining));
      reserved = round6(reserved + granted);
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
      logger.info('agent.session_start', {
        project_url: project.url, candidates: candidates.length, standing_withheld: plan[index].standing,
        budget_usd: granted,
      });
      try {
        results[index] = await runProjectSession({
          engine, definition, project, candidates, changes,
          feedback: feedbackFor(feedbackAll, project),
          alerts: alertsFor(project),
          memory,
          activeWindow: activeWindowOf(changes, { project, discovery }),
          config: ctx.config,
          gate: deps.gate,
          runDir: ctx.runDir,
          logger,
          tracer: ctx.tracer,
          deadline,
          localTools,
          localServers: replay ? replay.localServers : {},
          mcpConfig: replay ? { mcpServers: {} } : mcpConfig,
          budgetUsd: granted,
        });
      } finally {
        reserved = round6(reserved - granted);
        spent = round6(spent + ((results[index] && results[index].cost_usd) || 0));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, plan.length || 1) }, worker));

  const analysed = plan.filter((p, i) => results[i]).map((p) => p.project.url);
  const summary = {
    projects_analysed: analysed,
    projects_skipped: skipped,
    items: results.filter(Boolean).flatMap((r) => r.items),
    bounds_hit: [...new Set([
      ...results.filter(Boolean).flatMap((r) => r.bounds_hit), ...(budgetReached ? ['budget'] : []),
    ])],
    run_budget: {
      limit: runBudget === undefined || runBudget === null ? null : runBudget,
      spent, reached: budgetReached, not_analysed: notAnalysed,
    },
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
    run_budget_usd: runBudget, not_analysed: notAnalysed.length,
  });
  return summary;
};

module.exports = {
  name, inputs, run, asArray, feedbackFor, itemHistoryFor, selectProjects, planFor,
};
