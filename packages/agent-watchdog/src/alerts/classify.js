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

const emptyCounts = () => ({
  housekeeping: 0, firing: 0, new: 0, stale: 0, pending: 0, unknown_rules: 0 });

/**
 * @param {object} options
 * @param {object} options.collected the alerts.json document
 * @param {object} options.alertsPolicy the loaded alerts.yaml
 * @param {object[]} [options.projectGroups] projects.yaml groups (label, host_patterns)
 * @param {object|null} [options.previous] the previous run's alerts.classified.json, for newness and start dates
 * @param {Date|string} options.runStart
 * @param {Date|string} [options.observedAt] when the alerts were read; defaults to the file's `fetched_at`, then
 *   the run start
 * @param {Map|object|null} [options.changesByProject] Computed Changes per project url, for the metric shown next to
 *   an alert (FR-079)
 * @param {object} [options.categories] alerts.yaml categories: metric names per category
 * @param {Set<string>|null} [options.deadHosts] hosts whose scrape target was down all day: a stale alert there is
 *   housekeeping, not news (FR-080)
 * @param {object} [options.groupSizes] hosts per programme label, for programme-wide patterns (FR-078)
 */
const changesFor = (changesByProject, projectUrl) => {
  if (!changesByProject) {
    return [];
  }
  const found = changesByProject instanceof Map ? changesByProject.get(projectUrl) : changesByProject[projectUrl];
  return Array.isArray(found) ? found : [];
};

/** The computed change of the metric that explains an alert category, preferring the bare metric over variants. */
const evidenceFor = (instance, changesByProject, categories) => {
  const names = (categories && categories[instance.category]) || [];
  const related = changesFor(changesByProject, instance.project_url)
    .filter((change) => names.some((name) => String(change.metric).includes(name)))
    .sort((a, b) => a.metric.length - b.metric.length);
  const exact = related.find((change) => names.includes(change.metric));
  const change = exact || related[0];
  return change
    ? {
      metric: change.metric,
      aggregate: change.aggregate || 'level',
      current_value: change.current_value ?? null,
      previous_day_value: change.previous_day_value ?? null,
      pct_change_vs_previous_day: change.pct_change_vs_previous_day ?? null,
    }
    : null;
};

const compactHousekeeping = (instance) => ({
  instance_id: instance.instance_id,
  title: instance.title,
  host: instance.host,
  started_at: instance.started_at,
  days_firing: instance.days_firing,
});

const classifyAlerts = ({
  collected, alertsPolicy, projectGroups = [], previous = null, runStart, observedAt = null, changesByProject = null,
  categories = {}, deadHosts = null, groupSizes = {},
}) => {
  const staleAfterDays = (alertsPolicy && alertsPolicy.stale_after_days) || DEFAULT_STALE_AFTER_DAYS;
  // Ages count from when the alerts were read (the snapshot is live), else from the run start: a forced re-run of
  // a past date otherwise sees alerts that started after its date (revision 16).
  const start = new Date(observedAt || (collected && collected.fetched_at) || runStart);
  if (!collected || !collected.available) {
    return {
      available: false,
      reason: collected && collected.reason ? collected.reason : 'no alert data was collected',
      observed_at: start.toISOString(),
      stale_after_days: staleAfterDays,
      rules: [],
      instances: [],
      groups: [],
      housekeeping: [],
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
    const stale = firing && daysFiring >= staleAfterDays;
    const classified = {
      ...instance,
      group: instance.host ? groupFor(instance.host, projectGroups) : WATCHDOG,
      ...classification,
      started_at: startedAt,
      days_firing: daysFiring,
      stale,
      new: firing && !before,
      housekeeping: Boolean(stale && deadHosts && instance.host && deadHosts.has(instance.host)),
    };
    return { ...classified, evidence: firing ? evidenceFor(classified, changesByProject, categories) : null };
  });
  const firing = instances.filter((i) => i.state === 'firing' && !i.housekeeping);
  const housekeeping = instances.filter((i) => i.housekeeping);
  return {
    available: true,
    reason: null,
    observed_at: start.toISOString(),
    stale_after_days: staleAfterDays,
    rules,
    instances,
    groups: groupAlerts(instances, { groupSizes }),
    housekeeping: housekeeping.map(compactHousekeeping),
    counts: {
      firing: firing.length,
      new: firing.filter((i) => i.new).length,
      stale: firing.filter((i) => i.stale).length,
      housekeeping: housekeeping.length,
      pending: instances.filter((i) => i.state === 'pending').length,
      unknown_rules: rules.filter((r) => !r.known).length,
    },
  };
};

module.exports = { classifyAlerts, importanceOf, UNCATEGORISED, DEFAULT_STALE_AFTER_DAYS };
