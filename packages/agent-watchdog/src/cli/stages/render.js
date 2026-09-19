'use strict';
// Stage: render. Writes the one-page report and the brief image from the same brief (FR-022, FR-023).
const { requireInputs } = require('./index');
const { renderReport, windowKey } = require('../../render/report');
const { renderImage } = require('../../render/browser');
const { projectSlug } = require('../../model/identity');

const name = 'render';
const inputs = ['rollup/brief.json'];
const NO_IMAGE_KINDS = new Set(['heartbeat', 'failure']);

const slugFor = (discovery, projectUrl) => {
  const project = (discovery.projects || []).find((p) => p.url === projectUrl);
  if (project) {
    return project.slug;
  }
  try {
    return projectSlug(new URL(projectUrl).host);
  } catch {
    return null;
  }
};

const loadCurrentWindows = async (runDir, discovery, items) => {
  const byMetric = new Map();
  const slugs = [...new Set(items.map((item) => slugFor(discovery, item.project_url)).filter(Boolean))];
  for (const slug of slugs) {
    const rel = `${slug}/inputs/windows.json.gz`;
    if (!runDir.exists(rel)) {
      continue;
    }
    const raw = await runDir.readGz(rel);
    const windows = Array.isArray(raw) ? raw : (raw.windows || []);
    for (const window of windows) {
      if (window.window === 'current' && window.available !== false) {
        byMetric.set(windowKey(window.project_url, window.metric), window.values || []);
      }
    }
  }
  return byMetric;
};

const run = async (ctx) => {
  const { runDir, logger } = ctx;
  requireInputs(runDir, inputs);
  const brief = await runDir.readJson('rollup/brief.json');
  const items = runDir.exists('rollup/items.ranked.json') ? await runDir.readJson('rollup/items.ranked.json') : [];
  const discovery = runDir.exists('discovery.json')
    ? await runDir.readJson('discovery.json')
    : { projects: [], dashboards: [] };
  const windowsByMetric = await loadCurrentWindows(runDir, discovery, items);

  const html = renderReport({ brief, items, windowsByMetric, discovery, runId: ctx.runId });
  await runDir.writeText('rollup/report.html', html);

  if (NO_IMAGE_KINDS.has(brief.kind)) {
    logger.info('render.image_skipped', { kind: brief.kind });
    return { report: 'rollup/report.html', image: null };
  }

  await renderImage({
    html,
    browserLauncher: ctx.deps && ctx.deps.browserLauncher ? ctx.deps.browserLauncher : null,
    executablePath: ctx.config.runtime && ctx.config.runtime.chromiumPath ? ctx.config.runtime.chromiumPath : null,
    outputPath: runDir.path('rollup/brief.png'),
    logger,
  });
  brief.image = { path: 'rollup/brief.png', slack_file_id: null };
  await runDir.writeJson('rollup/brief.json', brief);
  return { report: 'rollup/report.html', image: 'rollup/brief.png' };
};

module.exports = { name, inputs, run };
