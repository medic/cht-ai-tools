'use strict';
// Alert Groups (FR-066, data-model.md): firing instances per programme and category, with counts, the oldest start,
// the highest importance and the members oldest first. Ordered by importance, then group and category in
// code-point order, so the same day always groups the same way.

const { detectPatterns } = require('./patterns');

const IMPORTANCE_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

const alertKey = (group, category) => `${group}/${category}`;

const byCodePoint = (a, b) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const unique = (values) => [...new Set(values.filter((v) => v !== null && v !== undefined))].sort(byCodePoint);

const compactMember = (instance) => ({
  instance_id: instance.instance_id,
  title: instance.title,
  host: instance.host,
  started_at: instance.started_at,
  days_firing: instance.days_firing,
  stale: instance.stale,
  new: instance.new,
  evidence: instance.evidence || null,
});

const topImportance = (instances) => instances
  .map((i) => i.importance)
  .sort((a, b) => IMPORTANCE_ORDER[a] - IMPORTANCE_ORDER[b])[0];

/**
 * @param {object[]} instances classified Alert Instances; only firing ones are grouped, and housekeeping ones
 *   (stale on a host with no data, FR-080) are left to the housekeeping line
 * @param {object} [options] `groupSizes`: hosts per programme label, for programme-wide patterns (FR-078)
 */
const groupAlerts = (instances, { groupSizes = {} } = {}) => {
  const patterns = detectPatterns({ instances, groupSizes });
  const byKey = new Map();
  for (const instance of instances || []) {
    if (instance.state !== 'firing' || instance.housekeeping) {
      continue;
    }
    const key = alertKey(instance.group, instance.category);
    if (!byKey.has(key)) {
      byKey.set(key, []);
    }
    byKey.get(key).push(instance);
  }
  const groups = [...byKey.entries()].map(([key, members]) => {
    const sorted = [...members].sort((a, b) => byCodePoint(a.started_at, b.started_at)
      || byCodePoint(a.instance_id, b.instance_id));
    return {
      alert_key: key,
      group: sorted[0].group,
      category: sorted[0].category,
      importance: topImportance(sorted),
      firing: sorted.length,
      new: sorted.filter((i) => i.new).length,
      stale: sorted.filter((i) => i.stale).length,
      oldest_started_at: sorted[0].started_at,
      rule_uids: unique(sorted.map((i) => i.rule_uid)),
      titles: unique(sorted.map((i) => i.title)),
      instance_ids: sorted.map((i) => i.instance_id),
      hosts: unique(sorted.map((i) => i.host)),
      instances: sorted.map(compactMember),
      patterns: patterns.filter((p) => p.group === sorted[0].group && p.category === sorted[0].category),
    };
  });
  return groups.sort((a, b) => IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance]
    || byCodePoint(a.group, b.group) || byCodePoint(a.category, b.category));
};

module.exports = { groupAlerts, alertKey, IMPORTANCE_ORDER };
