'use strict';
// Housekeeping and resolved lines (FR-080), written by code from the classified alerts and the episode record.
const { openEpisodes } = require('../alerts/episodes');

const DAY_MS = 86400000;
const MAX_NAMED = 3;

const byCodePoint = (a, b) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};
const listOf = (values) => `${values.slice(0, MAX_NAMED).join(', ')}${values.length > MAX_NAMED
  ? `, +${values.length - MAX_NAMED} more`
  : ''}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Stale alerts on hosts with no data: old news, named once, with what to do about them. */
const housekeepingNotice = (housekeeping) => {
  if (!housekeeping || !housekeeping.length) {
    return null;
  }
  const hosts = [...new Set(housekeeping.map((h) => h.host).filter(Boolean))].sort(byCodePoint);
  const minDays = Math.min(...housekeeping.map((h) => h.days_firing || 0));
  const one = housekeeping.length === 1;
  return `Housekeeping: ${plural(housekeeping.length, 'alert')} stale for ${minDays}+ days on `
    + `${plural(hosts.length, 'host')} with no data (${listOf(hosts)}): remove ${one ? 'it' : 'them'} from the `
    + `watchdog or silence the rule${one ? '' : 's'}`;
};

/** Open episodes whose instance no longer fires, with how long they fired, oldest first (`observedAt`, else
 * `runStart`, is when the alerts were read). */
const clearedEpisodes = ({ events, firingIds, runStart, observedAt = null, ignoredHosts = [] }) => {
  const reference = observedAt || runStart;
  const start = reference instanceof Date ? reference.getTime() : Date.parse(reference);
  const ignored = new Set(ignoredHosts);
  return [...openEpisodes(events).values()]
    .filter((episode) => !firingIds.has(episode.instance_id) && !(episode.host && ignored.has(episode.host)))
    .map((episode) => ({
      instance_id: episode.instance_id,
      title: episode.title,
      host: episode.host || null,
      days: Math.max(0, Math.floor((start - Date.parse(episode.started_at)) / DAY_MS)),
    }))
    .sort((a, b) => b.days - a.days || byCodePoint(a.instance_id, b.instance_id));
};

const resolvedNotice = (cleared) => {
  if (!cleared || !cleared.length) {
    return null;
  }
  const named = cleared.slice(0, MAX_NAMED).map((c) => `${c.title} on ${c.host || 'watchdog'} (fired ${c.days}d)`);
  const rest = cleared.length > MAX_NAMED ? `, +${cleared.length - MAX_NAMED} more` : '';
  return `Resolved since the previous run: ${named.join('; ')}${rest}`;
};

const dollars = (n) => `$${Number(n).toFixed(2)}`;

/** The run budget stopped the analysis (agent.summary.json `run_budget`): how far it got and what it left out. */
const runBudgetNotice = (summary) => {
  const budget = summary && summary.run_budget;
  if (!budget || !budget.reached || !(budget.not_analysed || []).length) {
    return null;
  }
  const analysed = (summary.projects_analysed || []).length;
  const left = budget.not_analysed.length;
  return `Analysis incomplete: the run budget of ${dollars(budget.limit)} was reached after ${analysed} of `
    + `${analysed + left} projects (${dollars(budget.spent)} spent); ${plural(left, 'project')} `
    + `${left === 1 ? 'was' : 'were'} not analysed`;
};

module.exports = { housekeepingNotice, clearedEpisodes, resolvedNotice, runBudgetNotice };
