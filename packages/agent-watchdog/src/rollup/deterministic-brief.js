'use strict';
// Briefs that need no model: the heartbeat (FR-021) and the degraded brief built from candidates (FR-017).
const { itemId } = require('../model/identity');
const { SEVERITY_ORDER, BODY_SLOTS } = require('./rank');

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

const baseBrief = ({ runId, footer, expectedLoadNotice }) => ({
  run_id: runId,
  expected_load_notice: expectedLoadNotice || null,
  degradation_notice: null,
  image: null,
  footer,
  publication: null,
});

const buildHeartbeat = ({ runId, discovery, candidatesCount = 0, footer, expectedLoadNotice = null }) => {
  const checked = checkedCounts(discovery, candidatesCount);
  return {
    ...baseBrief({ runId, footer, expectedLoadNotice }),
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

const candidateBullet = (candidate) => {
  const current = evidenceValue(candidate, ['current']);
  const baseline = evidenceValue(candidate, BASELINE_WINDOWS);
  const currentText = plain(current === null ? candidate.observed : current);
  const host = hostOf(candidate.project_url);
  return {
    item_id: itemId(candidate.project_url, candidate.metric, null),
    text: `${candidate.metric} on ${host}: ${currentText} vs ${plain(baseline)} (${candidate.rule})`,
  };
};

/** The deterministic brief: computed candidates only, clearly labelled, never silent (constitution III). */
const buildDeterministicBrief = ({ runId, candidates, discovery, reason, footer, expectedLoadNotice = null }) => {
  const seen = new Set();
  const bullets = [];
  for (const candidate of orderCandidates(candidates)) {
    const key = `${candidate.project_url}|${candidate.metric}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    bullets.push(candidateBullet(candidate));
    if (bullets.length === BODY_SLOTS) {
      break;
    }
  }
  const projects = new Set(candidates.map((c) => c.project_url)).size;
  return {
    ...baseBrief({ runId, footer, expectedLoadNotice }),
    kind: 'degraded',
    headline: `Watchdog brief (degraded): ${candidates.length} candidates across ${projects} projects`,
    bullets,
    checked: checkedCounts(discovery, candidates.length),
    degradation_notice: `Degraded brief: ${reason}. `
      + 'Bullets list computed candidates only, without model interpretation.',
  };
};

module.exports = { buildDeterministicBrief, buildHeartbeat, checkedCounts, hostOf, plain };
