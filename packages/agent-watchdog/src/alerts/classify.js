'use strict';
// Classification of collected alerts by code (FR-065): category and importance from the reviewed alerts.yaml (an
// unknown title is uncategorised and medium), the programme group from the host, when the instance started firing,
// how long it has fired, whether that makes it stale, and whether it is new since the previous run.
const { groupFor } = require('../collect/discovery');
const { groupAlerts } = require('./group');
const { WATCHDOG } = require('../rollup/layout');

const UNCATEGORISED = 'uncategorised';
const DEFAULT_STALE_AFTER_DAYS = 14;
const DAY_MS = 86400000;

const importanceOf = (title, alertsPolicy) => {
  const entry = alertsPolicy && alertsPolicy.rules ? alertsPolicy.rules[title] : null;
  if (entry) {
    return { category: entry.category, importance: entry.importance, known: true };
  }
  return { category: UNCATEGORISED, importance: 'medium', known: false };
};

const emptyCounts = () => ({ firing: 0, new: 0, stale: 0, pending: 0, unknown_rules: 0 });

/**
 * @param {object} options
 * @param {object} options.collected the alerts.json document
 * @param {object} options.alertsPolicy the loaded alerts.yaml
 * @param {object[]} [options.projectGroups] projects.yaml groups (label, host_patterns)
 * @param {object|null} [options.previous] the previous run's alerts.classified.json, for newness and start dates
 * @param {Date|string} options.runStart
 */
const classifyAlerts = ({ collected, alertsPolicy, projectGroups = [], previous = null, runStart }) => {
  const staleAfterDays = (alertsPolicy && alertsPolicy.stale_after_days) || DEFAULT_STALE_AFTER_DAYS;
  const start = runStart instanceof Date ? runStart : new Date(runStart);
  if (!collected || !collected.available) {
    return {
      available: false,
      reason: collected && collected.reason ? collected.reason : 'no alert data was collected',
      stale_after_days: staleAfterDays,
      rules: [],
      instances: [],
      groups: [],
      counts: emptyCounts(),
    };
  }
  const previousFiring = new Map(((previous && previous.instances) || [])
    .filter((i) => i.state === 'firing')
    .map((i) => [i.instance_id, i]));
  const rules = (collected.rules || []).map((rule) => ({ ...rule, ...importanceOf(rule.title, alertsPolicy) }));
  const instances = (collected.instances || []).map((instance) => {
    const classification = importanceOf(instance.title, alertsPolicy);
    const before = previousFiring.get(instance.instance_id);
    const startedAt = instance.active_at || (before && before.started_at) || start.toISOString();
    const daysFiring = Math.max(0, Math.floor((start.getTime() - Date.parse(startedAt)) / DAY_MS));
    const firing = instance.state === 'firing';
    return {
      ...instance,
      group: instance.host ? groupFor(instance.host, projectGroups) : WATCHDOG,
      ...classification,
      started_at: startedAt,
      days_firing: daysFiring,
      stale: firing && daysFiring >= staleAfterDays,
      new: firing && !before,
    };
  });
  const firing = instances.filter((i) => i.state === 'firing');
  return {
    available: true,
    reason: null,
    stale_after_days: staleAfterDays,
    rules,
    instances,
    groups: groupAlerts(instances),
    counts: {
      firing: firing.length,
      new: firing.filter((i) => i.new).length,
      stale: firing.filter((i) => i.stale).length,
      pending: instances.filter((i) => i.state === 'pending').length,
      unknown_rules: rules.filter((r) => !r.known).length,
    },
  };
};

module.exports = { classifyAlerts, importanceOf, UNCATEGORISED, DEFAULT_STALE_AFTER_DAYS };
