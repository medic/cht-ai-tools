'use strict';
// Stage `analyze`: computed changes and candidates per project, before any model involvement (FR-006, FR-014).
const { requireInputs } = require('./index');
const { activeWindow } = require('../../analyze/calendar');
const { computeChanges } = require('../../analyze/changes');
const { effectiveThresholds } = require('../../analyze/thresholds');
const { computeCandidates, suppressByHorizon } = require('../../analyze/candidates');
const { normaliseHost } = require('../../config/policy');
const { runStartOf } = require('./collect');

const name = 'analyze';
const inputs = ['discovery.json'];

const thresholdsAreDeployed = (policy, config) => {
  const source = policy.sources && policy.sources.thresholds;
  const configDir = config.storage && config.storage.configDir;
  return Boolean(source && configDir && source.startsWith(configDir));
};

const run = async (ctx) => {
  const { config, policy, logger, runDir } = ctx;
  const flags = ctx.flags || {};
  requireInputs(runDir, inputs);
  const discovery = await runDir.readJson('discovery.json');
  const runStart = runStartOf(ctx);
  const wanted = (flags.project || []).map(normaliseHost);
  const projects = wanted.length ? discovery.projects.filter((p) => wanted.includes(p.host)) : discovery.projects;
  const defaults = (policy.projects.defaults && policy.projects.defaults.expected_load_windows) || [];
  const globalSource = thresholdsAreDeployed(policy, config);
  let total = 0;

  for (const project of projects) {
    const started = process.hrtime.bigint();
    const rel = `${project.slug}/inputs/windows.json.gz`;
    requireInputs(runDir, [rel]);
    const stored = await runDir.readGz(rel);
    const active = activeWindow(defaults, project, runStart);
    const changes = computeChanges({ windows: stored.windows, project, activeWindow: active });
    const thresholds = effectiveThresholds(policy.thresholds, project.thresholds, { globalSource });
    const candidates = suppressByHorizon(computeCandidates({
      changes, project, thresholds, policy, date: ctx.date, windows: stored.windows,
    }), []);
    await runDir.writeJson(`${project.slug}/changes.json`, changes);
    await runDir.writeJson(`${project.slug}/candidates.json`, candidates);
    total += candidates.length;
    logger.info('analyze.project', {
      project: project.host,
      metrics: changes.length,
      candidates: candidates.length,
      high: candidates.filter((c) => c.severity_floor === 'high').length,
      active_window: active ? active.id : null,
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
    });
  }

  return { projects: projects.length, candidates: total };
};

module.exports = { name, inputs, run };
