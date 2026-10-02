const { suppressByHorizon } = require('../../src/analyze/candidates');

const candidate = (over) => ({
  candidate_id: 'c1', project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count', observed: 400, ...over,
});
const on = (date) => ({ date });
const run = (observed, note) => suppressByHorizon([candidate({ observed })], [horizon(note)], on('2026-09-18'));
const horizon = (over) => ({
  item_id: 'i1', project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count', pattern_card: null,
  horizon: '2026-10-01', expected_max: null, observed_value: 900, note: 'known migration', source_run_id: '2026-09-17',
  ...over,
});

describe('analyze/candidates suppressByHorizon (FR-029)', () => {
  it('suppresses a matching candidate before the horizon and lists why', () => {
    const result = suppressByHorizon([candidate()], [horizon()], { date: '2026-09-18' });
    expect(result.kept).to.deep.equal([]);
    expect(result.suppressed).to.have.length(1);
    expect(result.suppressed[0]).to.include({ candidate_id: 'c1', item_id: 'i1', horizon: '2026-10-01' });
    expect(result.suppressed[0].reason).to.be.a('string').and.include('2026-10-01');
  });

  it('still suppresses on the horizon date and stops after it', () => {
    expect(suppressByHorizon([candidate()], [horizon()], { date: '2026-10-01' }).kept).to.deep.equal([]);
    expect(suppressByHorizon([candidate()], [horizon()], { date: '2026-10-02' }).kept).to.have.length(1);
  });

  it('does not suppress a candidate that exceeds the noted expected maximum', () => {
    const result = run(400, { expected_max: 350 });
    expect(result.kept).to.have.length(1);
    expect(result.suppressed).to.deep.equal([]);
  });

  it('does not suppress a candidate more than 1.25 times the value observed when the note was left', () => {
    const below = run(370, { observed_value: 300 });
    const above = run(380, { observed_value: 300 });
    expect(below.kept).to.deep.equal([]);
    expect(above.kept).to.have.length(1);
  });

  it('always suppresses when the note carries neither an expected maximum nor an observed value', () => {
    const result = run(99999, { observed_value: null });
    expect(result.kept).to.deep.equal([]);
  });

  it('leaves other projects and metrics alone and returns the same list when there are no horizons', () => {
    const other = candidate({ candidate_id: 'c2', metric: 'cht_conflict_count' });
    const elsewhere = candidate({ candidate_id: 'c3', project_url: 'https://beta.example.org' });
    const result = suppressByHorizon([other, elsewhere], [horizon()], { date: '2026-09-18' });
    expect(result.kept.map((c) => c.candidate_id)).to.deep.equal(['c2', 'c3']);
    const list = [candidate()];
    expect(suppressByHorizon(list, [], { date: '2026-09-18' }).kept).to.equal(list);
  });
});
