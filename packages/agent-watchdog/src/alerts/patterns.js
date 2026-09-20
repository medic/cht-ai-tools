'use strict';
// Programme-wide alert patterns (FR-078): the same rule firing on most of a programme's projects within two days is
// one event. The brief names it once with the count and the window; the thread lists the projects.
const DAY_MS = 86400000;
const PATTERN_MIN_HOSTS = 3;
const PATTERN_MIN_SHARE = 0.5;
const PATTERN_WINDOW_MS = 2 * DAY_MS;

const byCodePoint = (a, b) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};
const unique = (values) => [...new Set(values.filter(Boolean))].sort(byCodePoint);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {object} options
 * @param {object[]} options.instances classified Alert Instances
 * @param {Object<string, number>} [options.groupSizes] hosts per programme label from discovery; when a programme's
 *   size is unknown the hosts seen firing stand in for it
 * @returns {object[]} patterns ordered by group then title
 */
const detectPatterns = ({ instances, groupSizes = {} }) => {
  const byGroupAndTitle = new Map();
  for (const instance of instances || []) {
    if (instance.state !== 'firing' || !instance.host || instance.housekeeping) {
      continue;
    }
    const key = `${instance.group}\u0000${instance.title}`;
    if (!byGroupAndTitle.has(key)) {
      byGroupAndTitle.set(key, []);
    }
    byGroupAndTitle.get(key).push(instance);
  }
  const patterns = [];
  for (const members of byGroupAndTitle.values()) {
    const hosts = unique(members.map((m) => m.host));
    const of = Math.max(groupSizes[members[0].group] || 0, hosts.length);
    const starts = members.map((m) => Date.parse(m.started_at)).filter(Number.isFinite);
    const span = starts.length ? Math.max(...starts) - Math.min(...starts) : 0;
    if (hosts.length < PATTERN_MIN_HOSTS || hosts.length / of < PATTERN_MIN_SHARE || span > PATTERN_WINDOW_MS) {
      continue;
    }
    patterns.push({
      group: members[0].group,
      category: members[0].category,
      title: members[0].title,
      count: hosts.length,
      of,
      since_min: day(Math.min(...starts)),
      since_max: day(Math.max(...starts)),
      hosts,
      instance_ids: members.map((m) => m.instance_id).sort(byCodePoint),
    });
  }
  return patterns.sort((a, b) => byCodePoint(a.group, b.group) || byCodePoint(a.title, b.title));
};

module.exports = { detectPatterns, PATTERN_MIN_HOSTS, PATTERN_MIN_SHARE, PATTERN_WINDOW_MS };
