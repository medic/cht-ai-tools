'use strict';
// A filtered run briefs only what it analysed (FR-087, revision 19). `--project` and `--group` (revision 24) restrict
// the analysis while discovery, collection, `alerts.classified.json` and `alerts/episodes.jsonl` deliberately stay
// whole: a narrow preview must not make another project's open episode look cleared, nor break the next full run's
// newness. So the narrowing happens here, on a copy, at presentation time only.
const { groupAlerts } = require('../alerts/group');
const { selectProjects, filterIsActive } = require('../config/filter');

/**
 * The hosts this run analysed, or null when it analysed everything discovered. Null is the unfiltered case and
 * every caller treats it as "change nothing", so the whole-run path stays exactly as it was.
 * @param {object} options
 * @param {object} options.discovery the run's discovery
 * @param {object} [options.flags] parsed command-line flags; `project` may be a url or a bare host, `group` a
 *   programme label, both repeatable
 * @returns {Set<string>|null}
 */
const analysedHosts = ({ discovery, flags = {} }) => {
  if (!filterIsActive(flags)) {
    return null;
  }
  const discovered = (discovery && discovery.projects) || [];
  const hosts = new Set(selectProjects(discovered, flags).map((p) => p.host));
  // Naming every discovered project is the whole run, and a filter is only meaningful if it leaves something out.
  return hosts.size === discovered.length ? null : hosts;
};

/** Records carrying a `host`, kept when the run analysed that host; unchanged when it analysed everything. */
const onAnalysedHosts = (records, hosts) => (hosts === null
  ? records
  : (records || []).filter((record) => record && record.host && hosts.has(record.host)));

const countsFor = (instances, housekeeping) => {
  const firing = instances.filter((i) => i.state === 'firing' && !i.housekeeping);
  return {
    firing: firing.length,
    new: firing.filter((i) => i.new).length,
    stale: firing.filter((i) => i.stale).length,
    housekeeping: housekeeping.length,
    pending: instances.filter((i) => i.state === 'pending').length,
    unknown_rules: 0,
  };
};

/**
 * The classified alerts as the brief should present them: instances on the analysed hosts only, regrouped so the
 * counts and the programme-wide patterns describe what the run looked at. The record it is given is never mutated.
 * @param {object} classified `alerts.classified.json`
 * @param {Set<string>|null} hosts from `analysedHosts`; null returns the record itself
 * @param {object} [options] `groupSizes`: hosts per programme, as the unfiltered grouping uses
 */
const scopeClassified = (classified, hosts, { groupSizes = {} } = {}) => {
  if (hosts === null || !classified || !classified.available) {
    return classified;
  }
  const instances = onAnalysedHosts(classified.instances, hosts);
  const housekeeping = onAnalysedHosts(classified.housekeeping, hosts);
  return {
    ...classified,
    instances,
    groups: groupAlerts(instances, { groupSizes }),
    housekeeping,
    counts: { ...countsFor(instances, housekeeping), unknown_rules: (classified.counts || {}).unknown_rules || 0 },
  };
};

module.exports = { analysedHosts, onAnalysedHosts, scopeClassified };
