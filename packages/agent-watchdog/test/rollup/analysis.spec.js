// Revision 16: the analysis record the roll-up derives from each project's passes.json, so a session stopped by a
// bound before any result is named in the brief instead of passing as "no metric changes".
const { analysisRecord, INCOMPLETE_BOUNDS } = require('../../src/rollup/analysis');

const passes = (overrides = {}) => ({
  passes: [{ pass: 1, attempt: 1, subtype: 'success' }], items: [{ item_id: 'a' }], converged: true, bounds_hit: [],
  errors: [], cost_usd: 0.4, ...overrides,
});

describe('rollup/analysis analysisRecord', () => {
  it('counts projects with a passes file and keeps completed sessions out of failed and incomplete', () => {
    const out = analysisRecord([
      { url: 'https://alpha.example.org', passes: passes() },
      { url: 'https://beta.example.org', passes: null },
      { url: 'https://gamma.example.org', passes: passes({ items: [], bounds_hit: ['passes'] }) },
    ]);
    expect(out).to.deep.equal({ projects: 2, failed: [], errors: [], incomplete: [] });
  });

  it('marks sessions with errors or the error bound as failed, with their messages', () => {
    const out = analysisRecord([
      { url: 'https://alpha.example.org', passes: passes({ items: [], bounds_hit: ['error'], errors: [] }) },
      {
        url: 'https://beta.example.org',
        passes: passes({
          items: [], bounds_hit: ['timeout'], errors: [{ pass: 1, attempt: 1, message: 'timed out', bound: 'timeout' }],
        }),
      },
    ]);
    expect(out.failed).to.deep.equal(['https://alpha.example.org', 'https://beta.example.org']);
    expect(out.errors).to.deep.equal(['timed out']);
    expect(out.incomplete).to.deep.equal([]);
  });

  it('marks a session stopped by its budget or turn cap with no result as incomplete, with what it spent', () => {
    const out = analysisRecord([
      { url: 'https://alpha.example.org', passes: passes({ items: [], bounds_hit: ['budget'], cost_usd: 0.84874 }) },
      { url: 'https://beta.example.org', passes: passes({ items: [], bounds_hit: ['turns'], cost_usd: 0.3 }) },
      // A bound hit after a pass produced items is a complete analysis: the items stand.
      { url: 'https://gamma.example.org', passes: passes({ bounds_hit: ['budget'] }) },
      // Stopped by a bound and failed: failed wins, never counted twice.
      {
        url: 'https://delta.example.org',
        passes: passes({ items: [], bounds_hit: ['budget', 'error'], errors: [{ message: 'boom', bound: 'error' }] }),
      },
    ]);
    expect(out.incomplete).to.deep.equal([
      { project_url: 'https://alpha.example.org', bounds: ['budget'], cost_usd: 0.84874 },
      { project_url: 'https://beta.example.org', bounds: ['turns'], cost_usd: 0.3 },
    ]);
    expect(out.failed).to.deep.equal(['https://delta.example.org']);
    expect(INCOMPLETE_BOUNDS).to.deep.equal(['budget', 'turns']);
  });
});
