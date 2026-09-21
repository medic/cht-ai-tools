// The agent stage's session plan (FR-013, revision 23): standing conditions are withheld from the session, and a
// project with nothing else opens none.
const { planFor } = require('../../src/cli/stages/agent');

const project = { url: 'https://north-a.example.org', host: 'north-a.example.org', slug: 'north-a-example-org' };
const backlog = (previous) => ({
  candidate_id: 'b'.repeat(12), project_url: project.url, metric: 'cht_outbound_push_backlog_count',
  rule: 'backlog_absolute', observed: 100, severity_floor: 'high',
  evidence: [
    { window: 'current', value: 100, unit: 'count' }, { window: 'previous_day', value: previous, unit: 'count' },
  ],
});
const monotonic = () => ({ ...backlog(0), candidate_id: 'm'.repeat(12), rule: 'monotonic', observed: 7 });

describe('cli/stages/agent planFor', () => {
  it('keeps the existing skip for a project without candidates', () => {
    expect(planFor({ project, candidates: [], changes: [] })).to.deep.equal({
      forModel: [], standing: [], skipReason: 'no candidates',
    });
  });

  it('skips a project whose every candidate is a standing condition and says so', () => {
    const plan = planFor({ project, candidates: [backlog(90)], changes: [] });
    expect(plan.skipReason).to.equal('standing conditions only');
    expect(plan.standing.map((c) => c.rule)).to.deep.equal(['backlog_absolute']);
    expect(plan.forModel).to.deep.equal([]);
  });

  it('hands the session only the candidates that are not standing', () => {
    const plan = planFor({ project, candidates: [backlog(90), monotonic()], changes: [] });
    expect(plan.skipReason).to.equal(null);
    expect(plan.forModel.map((c) => c.rule)).to.deep.equal(['monotonic']);
    expect(plan.standing.map((c) => c.rule)).to.deep.equal(['backlog_absolute']);
  });

  it('keeps a backlog new today for the model with its high floor', () => {
    const plan = planFor({ project, candidates: [backlog(0)], changes: [] });
    expect(plan.skipReason).to.equal(null);
    expect(plan.forModel.map((c) => c.rule)).to.deep.equal(['backlog_absolute']);
  });
});
