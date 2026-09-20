'use strict';
// Projects that appeared since the previous run are named in the brief (FR-001, SC-008, US5 scenario 1). A host
// without a projects.yaml entry is still analysed, with default thresholds; the notice says so. Nothing here
// changes the analysis, it only tells the reader what is new.
const { RunDir } = require('../store/run-dir');
const { previousRunIds } = require('./history');

const DEFAULT_MAX = 10;

/** Hosts discovered by the most recent earlier run that got as far as discovery, or null when there is none. */
const previousHostsFor = async ({ dataDir, runId }) => {
  for (const id of await previousRunIds(dataDir, runId)) {
    const run = RunDir.open(dataDir, id);
    if (run.exists('discovery.json')) {
      const discovery = await run.readJson('discovery.json');
      return new Set((discovery.projects || []).map((p) => p.host));
    }
  }
  return null;
};

const label = (project) => (project.configured ? project.host : `${project.host} (unconfigured)`);

const listOf = (projects, max, render = label) => {
  const shown = projects.slice(0, max).map(render);
  const rest = projects.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
};

/**
 * @param {object} options
 * @param {object} options.discovery this run's discovery document
 * @param {Set<string>|null} options.previousHosts hosts of the previous run, or null on the first run
 * @param {number} [options.max] hosts named before "and N more"
 * @returns {string[]} zero or one notice
 */
const newProjectNotices = ({ discovery, previousHosts, max = DEFAULT_MAX }) => {
  const projects = discovery.projects || [];
  if (!projects.length) {
    return [];
  }
  if (previousHosts === null || previousHosts === undefined) {
    const unconfigured = projects.filter((p) => !p.configured);
    const all = listOf(projects, max, (p) => p.host);
    const tail = unconfigured.length
      ? `; unconfigured, analysed with default thresholds: ${listOf(unconfigured, max, (p) => p.host)}`
      : '';
    return [`First run: ${projects.length} project${projects.length === 1 ? '' : 's'} analysed (${all})${tail}`];
  }
  const fresh = projects.filter((p) => !previousHosts.has(p.host));
  if (!fresh.length) {
    return [];
  }
  const noun = fresh.length === 1 ? 'New project' : 'New projects';
  const hint = fresh.some((p) => !p.configured)
    ? '; unconfigured means no projects.yaml entry, default thresholds apply'
    : '';
  return [`${noun} since the previous run: ${listOf(fresh, max)}${hint}`];
};

module.exports = { previousHostsFor, newProjectNotices, DEFAULT_MAX };
