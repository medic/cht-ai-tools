'use strict';
// Briefs that need no model: the heartbeat (FR-021) and the degraded brief built from candidates (FR-017).
const { itemId } = require('../model/identity');
const { layoutEntries, toLayoutDocument, assembleBullets, groupOfProjects, interleaveAlerts } = require('./layout');

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const BASELINE_WINDOWS = ['previous_day', 'previous_cycle', 'previous_week', 'trailing_14d'];

const hostOf = (projectUrl) => {
  try {
    return new URL(projectUrl).host;
  } catch {
    return String(projectUrl);
  }
};

const evidenceValue = (candidate, windows) => {
  for (const window of windows) {
    const found = (candidate.evidence || []).find((e) => e.window === window && typeof e.value === 'number');
    if (found) {
      return found.value;
    }
  }
  return null;
};

const plain = (value) => (value === null ? 'n/a' : String(Number(value.toFixed(2))));

const panelCount = (discovery) => (discovery.dashboards || [])
  .reduce((total, dashboard) => total + (dashboard.panels ? dashboard.panels.length : 0), 0);

const checkedCounts = (discovery, candidatesCount) => ({
  projects: (discovery.projects || []).length,
  panels: panelCount(discovery),
  candidates: candidatesCount,
});

const baseBrief = ({ runId, footer, expectedLoadNotice, notices = [] }) => ({
  run_id: runId,
  expected_load_notice: expectedLoadNotice || null,
  degradation_notice: null,
  notices: [...notices],
  image: null,
  footer,
  publication: null,
});

const buildHeartbeat = ({
  runId, discovery, candidatesCount = 0, footer, expectedLoadNotice = null, notices = [],
}) => {
  const checked = checkedCounts(discovery, candidatesCount);
  return {
    ...baseBrief({ runId, footer, expectedLoadNotice, notices }),
    kind: 'heartbeat',
    headline: `All quiet: ${checked.projects} projects and ${checked.panels} panels checked, no candidates`,
    bullets: [],
    checked,
  };
};

const orderCandidates = (candidates) => [...candidates].sort((a, b) => {
  const severity = SEVERITY_ORDER[a.severity_floor] - SEVERITY_ORDER[b.severity_floor];
  if (severity !== 0) {
    return severity;
  }
  const observed = Math.abs(b.observed || 0) - Math.abs(a.observed || 0);
  if (observed !== 0) {
    return observed;
  }
  return a.candidate_id.localeCompare(b.candidate_id);
});

const candidateText = (candidate) => {
  const host = hostOf(candidate.project_url);
  if (candidate.rule === 'restart') {
    const times = candidate.observed === 1 ? 'once' : `${plain(candidate.observed)} times`;
    return `${candidate.metric} on ${host}: restarted ${times} in the last 24 h (restart)`;
  }
  const current = evidenceValue(candidate, ['current']);
  const baseline = evidenceValue(candidate, BASELINE_WINDOWS);
  const currentText = plain(current === null ? candidate.observed : current);
  const perDay = (candidate.evidence || []).some((e) => e.note === 'increase over the window') ? '/day' : '';
  return `${candidate.metric} on ${host}: ${currentText}${perDay} vs ${plain(baseline)}${perDay} (${candidate.rule})`;
};

/**
 * The deterministic brief: computed candidates only, clearly labelled, never silent (constitution III). One line per
 * project and metric, keyed by the item id the analysis would give it, laid out with the same five-slot rule as the
 * model's brief so a programme's candidates share one bullet (FR-069).
 */
const buildDeterministicBrief = ({
  runId, candidates, discovery, reason, footer, expectedLoadNotice = null, notices = [], alertGroups = [],
  staleAfterDays = 14,
}) => {
  const groupOf = groupOfProjects(discovery);
  const byKey = new Map();
  for (const candidate of orderCandidates(candidates)) {
    const key = itemId(candidate.project_url, candidate.metric, null);
    if (!byKey.has(key)) {
      byKey.set(key, candidate);
    }
  }
  // Candidates stand in for items, keyed by the item id the analysis would give them, with their floor as severity.
  const pseudoItems = [...byKey.entries()].map(([key, candidate]) => ({
    item_id: key, project_url: candidate.project_url, severity: candidate.severity_floor,
  }));
  const bullets = assembleBullets({
    layout: toLayoutDocument(layoutEntries(interleaveAlerts(pseudoItems, alertGroups, groupOf))),
    textFor: (key) => candidateText(byKey.get(key)),
    hostFor: (key) => hostOf(byKey.get(key).project_url),
    alertGroups,
    staleAfterDays,
  });
  const projects = new Set(candidates.map((c) => c.project_url)).size;
  return {
    ...baseBrief({ runId, footer, expectedLoadNotice, notices }),
    kind: 'degraded',
    headline: `Watchdog brief (degraded): ${candidates.length} candidates across ${projects} projects`,
    bullets,
    checked: checkedCounts(discovery, candidates.length),
    degradation_notice: `Degraded brief: ${reason}. `
      + 'Bullets list computed candidates only, without model interpretation.',
  };
};

module.exports = { buildDeterministicBrief, buildHeartbeat, checkedCounts, hostOf, plain, candidateText };
