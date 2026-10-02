'use strict';
// Scrape-target health per project (FR-005). The `cht` job probes each instance's monitoring endpoint.
const { normaliseHost } = require('../config/policy');

const HEALTH = new Set(['up', 'down', 'unknown']);

const scrapeTargetsFor = (activeTargets, host) => activeTargets
  .filter((target) => target.labels && target.labels.instance && normaliseHost(target.labels.instance) === host)
  .map((target) => ({
    job: (target.labels && target.labels.job) || target.scrapePool || 'unknown',
    scrape_url: target.scrapeUrl || '',
    health: HEALTH.has(target.health) ? target.health : 'unknown',
    last_error: target.lastError ? String(target.lastError) : null,
  }));

const targetsSummary = (activeTargets) => {
  const cht = activeTargets.filter((t) => t.labels && t.labels.job === 'cht');
  const considered = cht.length ? cht : activeTargets;
  const summary = { up: 0, down: 0, unknown: 0 };
  for (const target of considered) {
    const health = HEALTH.has(target.health) ? target.health : 'unknown';
    summary[health] += 1;
  }
  return summary;
};

module.exports = { scrapeTargetsFor, targetsSummary };
