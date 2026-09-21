'use strict';
// The analysis record the roll-up derives from each project's passes.json (revision 13 and 16): which sessions
// failed (an error, or the error or timeout bound) and which were stopped by a bound before any pass produced a
// result. Both are named in the brief; the second would otherwise pass as "no metric changes to flag" while the
// computed candidates went unassessed.

/** Bounds that stop a session without an error: the per-session budget and the turn cap. */
const INCOMPLETE_BOUNDS = Object.freeze(['budget', 'turns']);

/**
 * Whether any pass produced items. passes.json carries items on each pass record, not at the top level; the
 * top-level form is kept for callers and fixtures that supply one (revision 22).
 */
const hasItems = (passes) => (passes.items || []).length > 0
  || (passes.passes || []).some((pass) => (pass.items || []).length > 0);

/** The failing check named most often across the gate reports of these passes, or `unknown`. */
const commonestFailingCheck = (passRecords) => {
  const counts = new Map();
  for (const pass of passRecords) {
    for (const check of (pass.gate && pass.gate.checks) || []) {
      if (check.status === 'fail') {
        counts.set(check.name, (counts.get(check.name) || 0) + 1);
      }
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : 'unknown';
};

/**
 * @param {Array<{ url: string, passes: object|null }>} projects each project's url and its passes.json, or null
 *   when the project was not analysed
 * @returns {{ projects: number, failed: string[], errors: string[], incomplete: object[], rejected: object[] }}
 *   `rejected` names the projects whose every pass the gate refused, each with its commonest failing check
 *   (revision 22): with one pass by default such a project would otherwise read as quiet.
 */
const analysisRecord = (projects) => {
  const record = { projects: 0, failed: [], errors: [], incomplete: [], rejected: [] };
  for (const { url, passes } of projects) {
    if (!passes) {
      continue;
    }
    record.projects += 1;
    const bounds = passes.bounds_hit || [];
    const failed = (passes.errors || []).length > 0 || bounds.includes('error');
    if (failed) {
      record.failed.push(url);
      for (const failure of passes.errors || []) {
        record.errors.push(failure.message);
      }
      continue;
    }
    const stopped = bounds.filter((bound) => INCOMPLETE_BOUNDS.includes(bound));
    if (stopped.length && !hasItems(passes)) {
      record.incomplete.push({ project_url: url, bounds: stopped, cost_usd: passes.cost_usd || 0 });
      continue;
    }
    const passRecords = passes.passes || [];
    const everyPassRejected = passRecords.length > 0
      && passRecords.every((pass) => pass.gate && pass.gate.outcome === 'rejected');
    if (!hasItems(passes) && everyPassRejected) {
      record.rejected.push({ project_url: url, reason: commonestFailingCheck(passRecords) });
    }
  }
  return record;
};

module.exports = { analysisRecord, INCOMPLETE_BOUNDS, hasItems, commonestFailingCheck };
