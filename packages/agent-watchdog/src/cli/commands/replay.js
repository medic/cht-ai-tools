'use strict';
// Replay: regenerate findings for a stored run from its retained inputs without contacting the metrics source or
// Slack (FR-041, US3 scenario 3; contracts/cli.md "replay"). Recorded tool results are served to the model in
// place of the live tools, the gate runs offline, and the only external call is the model API. The output lives
// under runs-replay/<run_id>/<label>/ with the run layout plus comparison.json (contracts/run-directory.md).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const codes = require('../exit-codes');
const { loadConfig } = require('../../config/load');
const { withEgressGuard } = require('../../net/egress');
const { RunDir, ensureDataLayout, RUN_ID_PATTERN } = require('../../store/run-dir');
const { createContext } = require('../context');
const { writeResult } = require('../streams');
const { createTracer } = require('../../trace/langfuse');
const { createFindingsGate } = require('../gate');
const { loadDefinition } = require('../../agent/definition');
const { createReplayLookup } = require('../../agent/tools/replay-shim');
const { diffItems } = require('../../agent/session-loop');
const { lastAcceptedFindingsFile: lastFindingsFile } = require('../../rollup/analysis');
const { selectProjects } = require('../stages/agent');
const { loadPatternCards } = require('../../corpus/cards');
const pkg = require('../../../package.json');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RUN_FILES = ['discovery.json', 'feedback.ingested.json'];
const PROJECT_FILES = ['changes.json', 'candidates.json', 'suppressed.json', 'inputs/windows.json.gz'];
const RECORDING = 'tool-calls.jsonl';
const RECORDED_COPY = 'recorded-tool-calls.jsonl';

const usage = (message) => new codes.ExitError(codes.USAGE, message);

/** `YYYYMMDDTHHMMSSZ`, so a replay without --label still gets a unique, sortable directory. */
const defaultLabel = (now) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

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

const resolveDirectory = (value, fallback, flagName) => {
  if (!value) {
    return fallback;
  }
  const resolved = path.resolve(process.cwd(), value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw usage(`--${flagName} ${value} is not a directory`);
  }
  return resolved;
};

const forcedNumber = (runId) => (runId.length > 10 ? Number(runId.slice(12)) : 0);

/**
 * Which stored runs to replay. A plain date means the latest run of that date (a forced run supersedes the earlier
 * post); a run id with `-f<n>` names that exact run; a range covers every run whose date falls inside it.
 */
const selectRunIds = async ({ dataDir, flags }) => {
  const hasDate = Boolean(flags.date);
  const hasRange = Boolean(flags.from || flags.to);
  if (hasDate && hasRange) {
    throw usage('--date cannot be combined with --from/--to');
  }
  if (!hasDate && !hasRange) {
    throw usage('replay needs --date <YYYY-MM-DD|run_id> or --from <YYYY-MM-DD> --to <YYYY-MM-DD>');
  }
  const ids = await RunDir.list(dataDir);
  if (hasDate) {
    if (!RUN_ID_PATTERN.test(flags.date)) {
      throw usage(`--date must be YYYY-MM-DD or a run id such as 2026-09-18-f1, got "${flags.date}"`);
    }
    if (DATE_PATTERN.test(flags.date)) {
      const sameDay = ids
        .filter((id) => id.slice(0, 10) === flags.date)
        .sort((a, b) => forcedNumber(a) - forcedNumber(b));
      if (!sameDay.length) {
        throw new codes.ExitError(codes.DATAERR, `no stored run for ${flags.date}`);
      }
      return { range: null, runIds: [sameDay[sameDay.length - 1]] };
    }
    if (!ids.includes(flags.date)) {
      throw new codes.ExitError(codes.DATAERR, `no stored run ${flags.date}`);
    }
    return { range: null, runIds: [flags.date] };
  }
  if (!flags.from || !flags.to) {
    throw usage('--from and --to must be given together');
  }
  if (!DATE_PATTERN.test(flags.from) || !DATE_PATTERN.test(flags.to)) {
    throw usage(`--from and --to must be YYYY-MM-DD, got "${flags.from}" and "${flags.to}"`);
  }
  if (flags.from > flags.to) {
    throw usage(`--from ${flags.from} is after --to ${flags.to}`);
  }
  const runIds = ids.filter((id) => id.slice(0, 10) >= flags.from && id.slice(0, 10) <= flags.to);
  if (!runIds.length) {
    throw new codes.ExitError(codes.DATAERR, `no stored runs between ${flags.from} and ${flags.to}`);
  }
  return { range: { from: flags.from, to: flags.to }, runIds };
};

const copyFile = async (source, target, fromRel, toRel = fromRel) => {
  if (!source.exists(fromRel)) {
    return false;
  }
  const destination = target.path(toRel);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source.path(fromRel), `${destination}.tmp`);
  await fsp.rename(`${destination}.tmp`, destination);
  return true;
};

const copyInputs = async ({ source, replayDir, projects }) => {
  for (const rel of RUN_FILES) {
    await copyFile(source, replayDir, rel);
  }
  for (const project of projects) {
    for (const rel of PROJECT_FILES) {
      await copyFile(source, replayDir, `${project.slug}/${rel}`);
    }
    await copyFile(source, replayDir, `${project.slug}/${RECORDING}`, `${project.slug}/${RECORDED_COPY}`);
  }
};

const defaultCreateEngine = ({ engineName, config, definition, mcpConfig, env, logger, runDir, replay }) => {
  if (engineName === 'cli') {
    const { createCliEngine } = require('../../agent/engine-cli');
    return createCliEngine({ config, definition, mcpConfig, env, logger, runDir, replay });
  }
  const { createSdkEngine } = require('../../agent/engine-sdk');
  return createSdkEngine({ config, definition, mcpConfig, env, logger });
};

const passSummary = async (dir, slug) => {
  const file = lastFindingsFile(dir, slug);
  if (!file) {
    return { pass: null, items: [], gate: null, records: [] };
  }
  const record = await dir.readJson(file);
  const items = Array.isArray(record.items) ? record.items : [];
  return {
    pass: record.pass === undefined ? null : record.pass,
    items: items.map((item) => item.item_id).sort(),
    gate: record.gate && record.gate.outcome ? record.gate.outcome : null,
    records: items,
  };
};

// "before" is what the roll-up used: the last pass the gate accepted (rollup/analysis.js, revision 34).
const compareProject = async ({ source, replayDir, project, unavailable }) => {
  const before = await passSummary(source, project.slug);
  const after = await passSummary(replayDir, project.slug);
  const diff = diffItems(before.records, after.records);
  return {
    project_url: project.url,
    slug: project.slug,
    before: { pass: before.pass, items: before.items, gate: before.gate },
    after: { pass: after.pass, items: after.items, gate: after.gate },
    added: diff.added.sort(),
    removed: diff.removed.sort(),
    changed: diff.changed.sort(),
    unavailable_tool_calls: unavailable.get(project.slug) || 0,
  };
};

const totalsOf = (projects) => projects.reduce((acc, p) => ({
  projects: acc.projects + 1,
  before_items: acc.before_items + p.before.items.length,
  after_items: acc.after_items + p.after.items.length,
  added: acc.added + p.added.length,
  removed: acc.removed + p.removed.length,
  changed: acc.changed + p.changed.length,
  unavailable_tool_calls: acc.unavailable_tool_calls + p.unavailable_tool_calls,
}), { projects: 0, before_items: 0, after_items: 0, added: 0, removed: 0, changed: 0, unavailable_tool_calls: 0 });

const elapsedMs = (startHr) => Number(process.hrtime.bigint() - startHr) / 1e6;

/** Replay one stored run into runs-replay/<run_id>/<label>/ and return its comparison. */
const replayOne = async ({
  runId, label, shared, tracer, stageName,
}) => {
  const { config, effective, policy, env, flags, logger, deps, definition, promptsDir, skillDir, versions } = shared;
  const dataDir = config.storage.dataDir;
  const source = RunDir.open(dataDir, runId);
  const sourceRun = await source.readRun();
  const date = sourceRun.date || runId.slice(0, 10);
  const replayDir = await RunDir.createReplay(dataDir, runId, label);
  const log = logger.child({ run_id: runId, replay_label: label });
  const startHr = process.hrtime.bigint();
  const traceUrl = await tracer.traceUrl();

  await replayDir.writeJson('config.effective.json', effective);
  await replayDir.updateRun({
    run_id: runId,
    replay_of: runId,
    label,
    date,
    mode: 'replay',
    status: 'created',
    started_at: new Date().toISOString(),
    finished_at: null,
    duration_ms: null,
    versions,
    source_versions: sourceRun.versions || null,
    prompts_dir: promptsDir,
    skill_dir: skillDir,
    config_effective_path: 'config.effective.json',
    stages: [],
    projects: [],
    usage: null,
    cost_usd: null,
    publications: [],
    trace_id: tracer.traceId || null,
    trace_url: traceUrl,
    supersedes: null,
    superseded_by: null,
    bounds_hit: [],
  });

  const fail = async (error) => {
    await replayDir.updateRun({
      status: 'failed', finished_at: new Date().toISOString(), duration_ms: elapsedMs(startHr),
    });
    log.error('replay.failed', { error });
    throw error;
  };

  if (!source.exists('discovery.json')) {
    await fail(new codes.ExitError(codes.DATAERR, `missing replay input: discovery.json in run ${runId}`));
  }
  const discovery = await source.readJson('discovery.json');
  const projects = selectProjects(discovery.projects || [], flags);
  await copyInputs({ source, replayDir, projects });

  const engineName = config.model.engine || 'sdk';
  const mcpConfig = { mcpServers: {} };
  const engineOptions = {
    engineName, config, definition, mcpConfig, env, logger: log, runDir: replayDir, replay: true,
  };
  const createEngine = deps.createEngine || defaultCreateEngine;
  const engine = deps.engine || createEngine(engineOptions);
  // Merged cards come from the skill directory under test, so a replay with --skill sees that skill's cards.
  const patternCards = deps.patternCards || loadPatternCards({ skillDir });
  const gate = typeof deps.gate === 'function'
    ? deps.gate
    : createFindingsGate({
      gateModule: deps.gateModule || require('../../verify/gate'), runDir: replayDir, config, offline: true,
      knownCards: patternCards.index,
    });

  const lookups = new Map();
  for (const project of projects) {
    const rel = `${project.slug}/${RECORDED_COPY}`;
    lookups.set(project.slug, createReplayLookup(replayDir.exists(rel) ? await replayDir.readJsonl(rel) : []));
  }
  const unavailable = new Map();
  const ctx = createContext({
    config, effective, policy, logger: log, runDir: replayDir, runId, date, mode: 'replay', tracer, engine, flags,
  });
  ctx.deps = { ...deps, gate, engine, definition, patternCards };
  ctx.definition = definition;
  ctx.env = env;
  ctx.deadline = Date.now() + config.bounds.runTimeoutMs;
  ctx.replay = {
    recordedFor: (slug) => lookups.get(slug) || null,
    onUnavailable: (slug, call) => {
      unavailable.set(slug, (unavailable.get(slug) || 0) + 1);
      log.debug('replay.tool_unavailable', { project_slug: slug, tool: call.tool });
    },
  };

  const agentStage = (deps.stages && deps.stages.agent) || require('../stages/agent');
  let summary;
  await replayDir.stageStart('agent');
  try {
    const stageCtx = ctx.forStage('agent');
    stageCtx.logger.info('stage.start', {});
    summary = await tracer.stage(stageName, () => agentStage.run(stageCtx));
    await replayDir.stageEnd('agent', 'completed');
  } catch (error) {
    await replayDir.stageEnd('agent', 'failed', { error: error.message });
    await fail(error);
  }

  const compared = [];
  for (const project of projects) {
    compared.push(await compareProject({ source, replayDir, project, unavailable }));
  }
  const durationMs = elapsedMs(startHr);
  const comparison = {
    run_id: runId,
    label,
    replay_dir: path.relative(dataDir, replayDir.root),
    engine: engine.name || engineName,
    prompts: { dir: promptsDir, hash: versions.prompts_hash },
    skill: { dir: skillDir, hash: versions.skill_hash },
    projects: compared,
    totals: totalsOf(compared),
    cost_usd: summary.cost_usd || 0,
    usage: summary.usage || null,
    duration_ms: durationMs,
  };
  await replayDir.writeJson('comparison.json', comparison);
  await replayDir.updateRun({
    status: 'drafted',
    finished_at: new Date().toISOString(),
    duration_ms: durationMs,
    cost_usd: summary.cost_usd || 0,
    usage: summary.usage || null,
    bounds_hit: summary.bounds_hit || [],
    projects: summary.projects_analysed || [],
  });
  log.info('replay.done', {
    totals: comparison.totals, cost_usd: comparison.cost_usd, duration_ms: durationMs,
  });
  return comparison;
};

const summariseRange = ({ range, label, comparisons, failed, runIds, startHr }) => {
  const totals = comparisons.reduce((acc, c) => ({
    before_items: acc.before_items + c.totals.before_items,
    after_items: acc.after_items + c.totals.after_items,
    added: acc.added + c.totals.added,
    removed: acc.removed + c.totals.removed,
    changed: acc.changed + c.totals.changed,
    unavailable_tool_calls: acc.unavailable_tool_calls + c.totals.unavailable_tool_calls,
    cost_usd: Number((acc.cost_usd + (c.cost_usd || 0)).toFixed(6)),
  }), { before_items: 0, after_items: 0, added: 0, removed: 0, changed: 0, unavailable_tool_calls: 0, cost_usd: 0 });
  return {
    from: range.from,
    to: range.to,
    label,
    runs: comparisons,
    summary: {
      runs: runIds.length,
      replayed: comparisons.length,
      failed,
      ...totals,
      duration_ms: elapsedMs(startHr),
    },
  };
};

/**
 * Replay a stored run (or every run in a date range) and print the items comparison on stdout.
 * `--compare` is accepted for the contract's sake; the comparison is always printed, since parseArgs offers no
 * way to pass a boolean flag as false.
 */
module.exports = async function replay({ flags = {}, env = process.env, stdout = process.stdout, logger, deps = {} }) {
  const { config, effective, policy } = loadConfig({ env, flags, command: 'replay' });
  // The model calls, the documentation service and the trace flush leave this process, so a replay runs under the
  // egress guard like a run (FR-083, revision 33).
  return withEgressGuard({ config, logger, deps }, (guarded) => replayLoaded({
    flags, env, stdout, logger, deps: guarded, config, effective, policy,
  }));
};

const replayLoaded = async ({ flags, env, stdout, logger, deps, config, effective, policy }) => {
  const now = deps.now ? deps.now() : new Date();
  const dataDir = config.storage.dataDir;
  const promptsDir = resolveDirectory(flags.prompts, config.paths.promptsDir, 'prompts');
  const skillDir = resolveDirectory(flags.skill, config.paths.skillDir, 'skill');
  const label = flags.label || defaultLabel(now);
  await ensureDataLayout(dataDir);
  const { range, runIds } = await selectRunIds({ dataDir, flags });

  const definition = deps.definition || loadDefinition({ paths: { ...config.paths, promptsDir, skillDir }, env });
  const versions = {
    package: pkg.version,
    git_sha: resolveGitSha(deps),
    ...definition.hashes,
    config_hash: policy.hash,
  };
  const shared = { config, effective, policy, env, flags, logger, deps, definition, promptsDir, skillDir, versions };
  const tracer = deps.tracer || createTracer({ config });
  const startHr = process.hrtime.bigint();

  // A rejected trace flush is logged and never changes the exit code, and the result is printed first (revision 35).
  const finishTrace = async (output) => {
    try {
      await tracer.finish({ output });
    } catch (traceError) {
      logger.warn('trace.finish_failed', { error: traceError });
    }
  };

  if (!range) {
    const runId = runIds[0];
    await tracer.start({ runId, date: runId.slice(0, 10), mode: 'replay', tags: ['replay', label] });
    try {
      const comparison = await replayOne({ runId, label, shared, tracer, stageName: 'agent' });
      writeResult(stdout, comparison);
      await finishTrace({ status: 'drafted', totals: comparison.totals, cost_usd: comparison.cost_usd });
      return codes.OK;
    } catch (error) {
      await finishTrace({ status: 'failed', error: error.message });
      throw error;
    }
  }

  await tracer.start({
    runId: `replay-${range.from}..${range.to}`, date: range.to, mode: 'replay', tags: ['replay', 'range', label],
  });
  const comparisons = [];
  const failed = [];
  let lastError = null;
  let cursor = 0;
  const worker = async () => {
    while (cursor < runIds.length) {
      const runId = runIds[cursor];
      cursor += 1;
      try {
        comparisons.push(await replayOne({ runId, label, shared, tracer, stageName: `${runId}/agent` }));
      } catch (error) {
        lastError = error;
        failed.push({ run_id: runId, error: error.message });
        logger.warn('replay.run_failed', { run_id: runId, error });
      }
    }
  };
  const concurrency = Math.max(1, Math.min(config.bounds.projectConcurrency || 1, runIds.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  comparisons.sort((a, b) => a.run_id.localeCompare(b.run_id));
  const report = summariseRange({ range, label, comparisons, failed, runIds, startHr });
  if (!comparisons.length) {
    await finishTrace({ status: 'failed', summary: report.summary });
    throw lastError;
  }
  writeResult(stdout, report);
  await finishTrace({ status: 'drafted', summary: report.summary });
  return codes.OK;
};

module.exports.selectRunIds = selectRunIds;
module.exports.defaultLabel = defaultLabel;
