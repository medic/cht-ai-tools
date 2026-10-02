'use strict';
// The one way a run is restricted to some of the discovered projects (FR-087, revision 24): hosts named with
// `--project`, whole programmes named with `--group`, or everything. Every stage and the presentation scope use this
// helper, so a filtered run analyses, briefs and reports one set.
const { normaliseHost } = require('./policy');

const labelsOf = (flags) => ((flags && flags.group) || []).map((label) => String(label).trim().toLowerCase());

const hostsOf = (flags) => ((flags && flags.project) || []).map(normaliseHost);

/** Does the run carry a project or group filter at all? */
const filterIsActive = (flags) => hostsOf(flags).length > 0 || labelsOf(flags).length > 0;

/**
 * The projects the flags select: a host written as a host or a URL, a programme by its exact label (case does not
 * matter), the union of both. No filter selects everything; an unknown label selects nothing, never everything.
 */
const selectProjects = (projects, flags) => {
  const hosts = hostsOf(flags);
  const labels = labelsOf(flags);
  if (!hosts.length && !labels.length) {
    return projects;
  }
  return (projects || []).filter((p) => hosts.includes(p.host)
    || (p.group && labels.includes(String(p.group).trim().toLowerCase())));
};

module.exports = { selectProjects, filterIsActive };
