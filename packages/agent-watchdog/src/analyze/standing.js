'use strict';
// Standing conditions (FR-013, FR-014, revision 23): a high-rule candidate whose condition already held the previous
// day. It is computed and recorded like any candidate, derived here from fields the candidate and its Computed Change
// already carry, and handed to no session: code names it once in the brief and lists it in the report, because a
// model turn on "the backlog is still above zero" adds nothing the reader does not know (research.md R-28).
const { formatValue } = require('../verify/format');

const STANDING_RULES = Object.freeze(['backlog_absolute', 'target_down']);

const RULE_TEXT = { backlog_absolute: 'outbound push backlog above zero' };

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const evidenceValue = (candidate, window) => {
  const found = (candidate.evidence || []).find((e) => e.window === window);
  return found && typeof found.value === 'number' ? found.value : null;
};

const previousDayValue = (candidate) => evidenceValue(candidate, 'previous_day')
  ?? evidenceValue(candidate, 'previous_cycle');

const changeFor = (candidate, changes) => (changes || []).find((c) => c.metric === candidate.metric) || null;

/**
 * Did this candidate's condition already hold? A backlog above zero yesterday as well is routine for a CHT
 * deployment; a scrape target is standing only when it read zero yesterday and throughout the trailing fortnight
 * (its trailing mean is zero), because an outage in its second day is news and a host dark for weeks is not.
 */
const isStanding = (candidate, changes = []) => {
  if (candidate.rule === 'backlog_absolute') {
    const previous = previousDayValue(candidate);
    return previous !== null && previous > 0;
  }
  if (candidate.rule === 'target_down') {
    const change = changeFor(candidate, changes);
    return Boolean(change) && change.previous_day_value === 0 && change.trailing_mean === 0;
  }
  return false;
};

/** The candidates the model is handed and the standing ones code keeps, in their original order. */
const splitStanding = ({ candidates = [], changes = [] }) => {
  const forModel = [];
  const standing = [];
  for (const candidate of candidates) {
    (isStanding(candidate, changes) ? standing : forModel).push(candidate);
  }
  return { forModel, standing };
};

/** One record per standing candidate of a project (rollup/standing.json). */
const standingRecords = ({ candidates = [], changes = [], project, groupOf = () => 'Other' }) => splitStanding({
  candidates, changes,
}).standing.map((candidate) => {
  const change = changeFor(candidate, changes);
  const previous = candidate.rule === 'target_down' && change
    ? change.previous_day_value
    : previousDayValue(candidate);
  return {
    rule: candidate.rule,
    project_url: project.url,
    host: project.host,
    group: groupOf(project.url),
    metric: candidate.metric,
    value: evidenceValue(candidate, 'current') ?? candidate.observed,
    previous_day_value: previous,
  };
});

/** The hosts dark today, yesterday and throughout the trailing fortnight; the housekeeping line names them (FR-080). */
const darkHostsOf = (records) => [...new Set((records || [])
  .filter((record) => record.rule === 'target_down' && record.host)
  .map((record) => record.host))].sort();

/**
 * One notice per standing rule with a text of its own, grouped by programme with the count out of the programme's
 * size and the largest value; dark hosts belong to the housekeeping line instead.
 */
const standingNotices = ({ records = [], groupSizes = {} }) => {
  const lines = [];
  for (const [rule, text] of Object.entries(RULE_TEXT)) {
    const own = records.filter((record) => record.rule === rule);
    if (!own.length) {
      continue;
    }
    const byGroup = new Map();
    for (const record of own) {
      byGroup.set(record.group, (byGroup.get(record.group) || 0) + 1);
    }
    const groups = [...byGroup.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0]))
      .map(([group, count]) => `${group} ${count} of ${Math.max(groupSizes[group] || 0, count)}`);
    const byValue = (a, b) => Number(b.value) - Number(a.value) || String(a.host).localeCompare(b.host);
    const largest = [...own].sort(byValue)[0];
    lines.push(`Standing: ${text} on ${plural(own.length, 'project')} as yesterday (${groups.join(', ')}); `
      + `largest ${largest.host} ${formatValue(largest.value)}`);
  }
  return lines;
};

module.exports = {
  STANDING_RULES, isStanding, splitStanding, standingRecords, standingNotices, darkHostsOf, RULE_TEXT,
};
