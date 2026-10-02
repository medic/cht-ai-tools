'use strict';
// Stage: render. Writes the report from the brief, the ranked items, the standing conditions and the alert groups
// (FR-022). No image since revision 24: the brief image was a capture of the Slack message itself (FR-023 retired).
const { requireInputs } = require('./index');
const { renderReport, windowKey } = require('../../render/report');
const { projectSlug } = require('../../model/identity');

const name = 'render';
const inputs = ['rollup/brief.json'];
// A heartbeat or a failure notice is one line in Slack; the report is written for the record but not shared.
const NO_REPORT_KINDS = new Set(['heartbeat', 'failure']);

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

const readIfPresent = async (runDir, rel, fallback) => (runDir.exists(rel) ? runDir.readJson(rel) : fallback);

const run = async (ctx) => {
  const { runDir, logger } = ctx;
  requireInputs(runDir, inputs);
  const brief = await runDir.readJson('rollup/brief.json');
  const items = await readIfPresent(runDir, 'rollup/items.ranked.json', []);
  const discovery = await readIfPresent(runDir, 'discovery.json', { projects: [], dashboards: [] });
  const windowsByMetric = await loadCurrentWindows(runDir, discovery, items);
  // Standing conditions the roll-up handed to no session (FR-014, revision 23) and the alert groups it briefed.
  const standing = await readIfPresent(runDir, 'rollup/standing.json', []);
  const alertGroups = await readIfPresent(runDir, 'rollup/alert-groups.json', []);
  // Where the report's references point (FR-022, revision 24): the hosted watchdog, or nowhere.
  const links = {
    mode: (ctx.config.publish && ctx.config.publish.reportLinks) || 'internal',
    grafanaUrl: (ctx.config.endpoints && ctx.config.endpoints.grafanaUrl) || null,
    runStart: ctx.runStart || discovery.run_start || `${ctx.date}T06:00:00Z`,
  };

  const html = renderReport({
    brief, items, windowsByMetric, discovery, runId: ctx.runId, standing, alertGroups, links,
  });
  await runDir.writeText('rollup/report.html', html);
  logger.info('render.report', {
    kind: brief.kind, items: items.length, standing: standing.length, alerts: alertGroups.length, links: links.mode,
  });

  brief.image = null;
  // The report is shared into the thread by the publish stage (FR-022, revision 23), never for a one-line post.
  brief.report = NO_REPORT_KINDS.has(brief.kind) ? null : { path: 'rollup/report.html', slack_file_id: null, ts: null };
  await runDir.writeJson('rollup/brief.json', brief);
  return { report: 'rollup/report.html', image: null };
};

module.exports = { name, inputs, run };
