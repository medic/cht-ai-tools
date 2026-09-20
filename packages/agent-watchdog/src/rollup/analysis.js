'use strict';
// The analysis record the roll-up derives from each project's passes.json (revision 13 and 16): which sessions
// failed (an error, or the error or timeout bound) and which were stopped by a bound before any pass produced a
// result. Both are named in the brief; the second would otherwise pass as "no metric changes to flag" while the
// computed candidates went unassessed.

/** Bounds that stop a session without an error: the per-session budget and the turn cap. */
const INCOMPLETE_BOUNDS = Object.freeze(['budget', 'turns']);

/**
 * @param {Array<{ url: string, passes: object|null }>} projects each project's url and its passes.json, or null
 *   when the project was not analysed
 * @returns {{ projects: number, failed: string[], errors: string[], incomplete: object[] }}
 */
const analysisRecord = (projects) => {
  const record = { projects: 0, failed: [], errors: [], incomplete: [] };
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
    if (stopped.length && !(passes.items || []).length) {
      record.incomplete.push({ project_url: url, bounds: stopped, cost_usd: passes.cost_usd || 0 });
    }
  }
  return record;
};

module.exports = { analysisRecord, INCOMPLETE_BOUNDS };
