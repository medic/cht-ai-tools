const { buildDeterministicBrief, buildHeartbeat } = require('../../src/rollup/deterministic-brief');
const { schemas } = require('../../src/model/schemas');
const { makeCandidate, makeDiscovery, footer } = require('./factories');

describe('rollup/deterministic-brief', () => {
  it('builds a degraded brief from the highest-severity candidates with plain numbers and a notice', () => {
    const candidates = [
      makeCandidate({
        candidate_id: 'aaaaaaaaaaaa',
        severity_floor: 'low',
        metric: 'cht_conflict_count',
        observed: 60,
        evidence: [
          { window: 'current', value: 24.456, unit: 'count' },
          { window: 'previous_day', value: 15.2, unit: 'count' },
        ],
      }),
      makeCandidate({ candidate_id: 'bbbbbbbbbbbb', severity_floor: 'high' }),
      makeCandidate({ candidate_id: 'cccccccccccc', severity_floor: 'medium', metric: 'cht_replication_limit_count', project_url: 'https://beta.example.org', observed: 70 }),
      makeCandidate({ candidate_id: 'dddddddddddd', severity_floor: 'low', metric: 'cht_feedback_total', project_url: 'https://gamma.example.org', observed: 55 }),
    ];
    const brief = buildDeterministicBrief({
      runId: '2026-09-18',
      candidates,
      discovery: makeDiscovery(),
      reason: 'gate rejected three drafts',
      footer: footer(),
      expectedLoadNotice: null,
    });
    expect(() => schemas.Brief.parse(brief)).to.not.throw();
    expect(brief.kind).to.equal('degraded');
    expect(brief.headline).to.equal('Watchdog brief (degraded): 4 candidates across 3 projects');
    expect(brief.bullets).to.have.length(3);
    expect(brief.bullets[0].text).to.equal('cht_sentinel_backlog_count on alpha.example.org: 912 vs 300 (pct_change)');
    expect(brief.bullets[1].text).to.include('cht_replication_limit_count on beta.example.org');
    expect(brief.bullets[2].text).to.match(/^cht_(conflict_count|feedback_total) on/);
    expect(brief.degradation_notice).to.include('gate rejected three drafts');
    expect(brief.checked).to.deep.equal({ projects: 3, panels: 3, candidates: 4 });
    expect(brief.image).to.equal(null);
    expect(brief.footer).to.deep.equal(footer());
  });

  it('writes fractional values with at most two decimals and no thousands formatting', () => {
    const brief = buildDeterministicBrief({
      runId: 'r', discovery: makeDiscovery(), reason: 'model unavailable', footer: footer(), expectedLoadNotice: null,
      candidates: [makeCandidate({
        evidence: [
          { window: 'current', value: 1234.5678, unit: 'count' },
          { window: 'previous_day', value: 1000.129, unit: 'count' },
        ],
      })],
    });
    expect(brief.bullets[0].text).to.include('1234.57 vs 1000.13');
  });

  it('builds a heartbeat that says what was checked', () => {
    const brief = buildHeartbeat({
      runId: '2026-09-18',
      discovery: makeDiscovery(),
      candidatesCount: 0,
      footer: footer(),
      expectedLoadNotice: 'Month-end window active',
    });
    expect(() => schemas.Brief.parse(brief)).to.not.throw();
    expect(brief.kind).to.equal('heartbeat');
    expect(brief.headline).to.equal('All quiet: 3 projects and 3 panels checked, no candidates');
    expect(brief.bullets).to.deep.equal([]);
    expect(brief.expected_load_notice).to.equal('Month-end window active');
    expect(brief.checked).to.deep.equal({ projects: 3, panels: 3, candidates: 0 });
  });
});
