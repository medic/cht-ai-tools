'use strict';
// Builds the findings a careful model would return for one project, read from the run directory: one item per
// metric with evidence equal to the computed values. Shared by the e2e scripted engine (test/e2e/helpers.js)
// and the fake `claude` executable (test/helpers/fake-claude.js) so both engines answer identically.
const fs = require('node:fs');
const path = require('node:path');
const atomic = require('../../src/store/atomic');

const ID_PATTERN = /\b[0-9a-f]{12}\b/g;

/** The most recent run directory under a data volume (runs/<id>, ids sort chronologically). */
const latestRunRoot = (dataDir) => {
  const runsDir = path.join(dataDir, 'runs');
  const runId = fs.readdirSync(runsDir).sort().pop();
  return path.join(runsDir, runId);
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Every project directory of a run that holds candidates, with its candidates and computed changes. */
const projectsWithCandidates = (root) => fs.readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'candidates.json')))
  .map((d) => {
    const slug = d.name;
    const candidates = readJson(path.join(root, slug, 'candidates.json'));
    const changes = readJson(path.join(root, slug, 'changes.json'));
    return { slug, root, candidates, changes };
  });

/** The project whose candidate ids appear in a prompt, if any. */
const projectForPrompt = (root, promptText) => {
  const ids = [...new Set(promptText.match(ID_PATTERN) || [])];
  return projectsWithCandidates(root).find((p) => p.candidates.some((c) => ids.includes(c.candidate_id))) || null;
};

// Scrape-target candidates carry a pseudo panel reference ('targets'); point the item at a real panel
// on the first priority dashboard instead, as the prompt instructs the model to do.
const dashboardRefFor = (root, cands) => {
  const discovery = readJson(path.join(root, 'discovery.json'));
  const known = new Set(discovery.dashboards.map((d) => d.uid));
  const real = cands.find((c) => known.has(c.panel_ref.dashboard_uid));
  if (real) {
    return { dashboard_uid: real.panel_ref.dashboard_uid, panel_id: real.panel_ref.panel_id };
  }
  const first = discovery.dashboards[0];
  const uptime = first.panels.find((p) => /uptime/i.test(p.title)) || first.panels[0];
  return { dashboard_uid: first.uid, panel_id: uptime.panel_id };
};

/** One model item per metric of the project, with evidence equal to the computed values. */
const itemsFor = async (project) => {
  const byMetric = new Map();
  for (const c of project.candidates) {
    if (!byMetric.has(c.metric)) {
      byMetric.set(c.metric, []);
    }
    byMetric.get(c.metric).push(c);
  }
  const windows = await atomic.readGzipJson(path.join(project.root, project.slug, 'inputs', 'windows.json.gz'));
  const items = [];
  for (const [metric, cands] of byMetric) {
    const change = project.changes.find((ch) => ch.metric === metric);
    const current = windows.windows.find((w) => w.metric === metric && w.window === 'current');
    const unit = cands[0].evidence[0] ? cands[0].evidence[0].unit : 'count';
    const evidence = [{ window: 'current', value: change.current_value, unit }];
    if (change.previous_day_value !== null) {
      evidence.push({ window: 'previous_day', value: change.previous_day_value, unit });
    }
    const severity = cands.some((c) => c.severity_floor === 'high') ? 'high' : 'low';
    items.push({
      item_key: { metric, pattern_card: null },
      severity,
      evidence,
      why_now: cands.some((c) => c.rule === 'target_down')
        ? 'The scrape target is down, so the watchdog has no fresh data for this project.'
        : 'The backlog has climbed steadily for hours and is now well above yesterday.',
      suggested_check: 'Open the dashboard panel and confirm the trend before paging anyone.',
      dashboard_ref: { ...dashboardRefFor(project.root, cands), from: current.start, to: current.end },
      confidence: 0.85,
      candidate_ids: cands.map((c) => c.candidate_id),
      reference_urls: [],
    });
  }
  return { items, unitOf: (metric) => (byMetric.get(metric)[0].evidence[0] || {}).unit || 'count' };
};

/** A complete findings document for a project and pass. */
const findingsFor = async (project, pass) => {
  const { items } = await itemsFor(project);
  return {
    project_url: project.candidates[0].project_url,
    pass,
    items,
    not_selected: [],
    changes: [],
    converged: pass > 1,
    notes: '',
  };
};

/** The usage and cost a scripted turn reports. */
const resultStub = () => ({
  subtype: 'success',
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
  total_cost_usd: 0.01,
  num_turns: 2,
  duration_ms: 120,
  session_id: 'sess-1',
  permission_denials: [],
  errors: [],
});

module.exports = {
  ID_PATTERN, latestRunRoot, projectsWithCandidates, projectForPrompt, dashboardRefFor, itemsFor, findingsFor,
  resultStub,
};
