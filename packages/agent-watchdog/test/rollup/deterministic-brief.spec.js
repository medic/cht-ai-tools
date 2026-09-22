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
    expect(brief.bullets).to.have.length(4);
    expect(brief.bullets[0].text).to.equal('cht_sentinel_backlog_count on alpha.example.org: 912 vs 300 (pct_change)');
    expect(brief.bullets[0]).to.include({ kind: 'item', group: 'Other' });
    expect(brief.bullets[1].text).to.include('cht_replication_limit_count on beta.example.org');
    expect(brief.bullets[2].text).to.match(/^cht_(conflict_count|feedback_total) on/);
    expect(brief.bullets[3].text).to.match(/^cht_(conflict_count|feedback_total) on/);
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

  it('keeps five slots and collapses a programme into one bullet with sub-bullets (FR-010, FR-069)', () => {
    const { makeProject } = require('./factories');
    const discovery = makeDiscovery({
      projects: [
        makeProject('north-a.example.org', { group: 'North Programme' }),
        makeProject('north-b.example.org', { group: 'North Programme' }),
        ...['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((h) => makeProject(`${h}.example.org`)),
      ],
    });
    const candidates = [
      makeCandidate({ candidate_id: 'aaaaaaaaaaaa', severity_floor: 'high', project_url: 'https://north-a.example.org' }),
      makeCandidate({ candidate_id: 'bbbbbbbbbbbb', severity_floor: 'high', project_url: 'https://north-b.example.org' }),
      ...['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((h, i) => makeCandidate({
        candidate_id: String(i).repeat(12), severity_floor: 'low', project_url: `https://${h}.example.org`, observed: 60 - i,
      })),
    ];
    const brief = buildDeterministicBrief({
      runId: 'r', candidates, discovery, reason: 'model unavailable', footer: footer(), expectedLoadNotice: null,
    });
    expect(() => schemas.Brief.parse(brief)).to.not.throw();
    expect(brief.bullets).to.have.length(5);
    expect(brief.bullets[0]).to.include({ kind: 'group', group: 'North Programme' });
    expect(brief.bullets[0].text).to.equal('North Programme: 2 projects with issues');
    expect(brief.bullets[0].children.map((c) => c.text)).to.deep.equal([
      'cht_sentinel_backlog_count on north-a.example.org: 912 vs 300 (pct_change)',
      'cht_sentinel_backlog_count on north-b.example.org: 912 vs 300 (pct_change)',
    ]);
    expect(brief.bullets.slice(1).every((b) => b.kind === 'item' && b.children.length === 0)).to.equal(true);
    expect(brief.bullets.slice(1).map((b) => b.text)).to.deep.equal([
      'cht_sentinel_backlog_count on alpha.example.org: 912 vs 300 (pct_change)',
      'cht_sentinel_backlog_count on beta.example.org: 912 vs 300 (pct_change)',
      'cht_sentinel_backlog_count on gamma.example.org: 912 vs 300 (pct_change)',
      'cht_sentinel_backlog_count on delta.example.org: 912 vs 300 (pct_change)',
    ]);
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

describe('rollup/deterministic-brief: alert bullets (User Story 8)', () => {
  const { classified, groupOf: alertGroupOf } = require('../helpers/alerts');
  const south = alertGroupOf([classified('delivery', 'south-a.example.org')]);

  it('keeps the alerts bullet in a degraded brief, laid out by importance among the candidates', () => {
    const brief = buildDeterministicBrief({
      runId: 'r', candidates: [makeCandidate()], discovery: makeDiscovery(), reason: 'model unavailable',
      footer: footer(), expectedLoadNotice: null, alertGroups: [south], staleAfterDays: 14,
    });
    expect(() => schemas.Brief.parse(brief)).to.not.throw();
    expect(brief.bullets.map((b) => b.kind)).to.deep.equal(['item', 'alerts']);
    expect(brief.bullets[1].text).to.equal('South Programme alerts: 1 firing, none stale');
    expect(brief.bullets[1].children).to.have.length(1);
  });
});

describe('rollup/deterministic-brief: what was checked counts the analysed projects (FR-066, revision 25)', () => {
  const { checkedCounts } = require('../../src/rollup/deterministic-brief');

  it('counts the analysed projects when the run was restricted, and every discovered project otherwise', () => {
    expect(checkedCounts(makeDiscovery(), 4, 2)).to.deep.equal({ projects: 2, panels: 3, candidates: 4 });
    expect(checkedCounts(makeDiscovery(), 4)).to.deep.equal({ projects: 3, panels: 3, candidates: 4 });
    expect(checkedCounts(makeDiscovery(), 4, null)).to.deep.equal({ projects: 3, panels: 3, candidates: 4 });
  });

  it('says so in the heartbeat headline and the degraded brief', () => {
    const quiet = buildHeartbeat({
      runId: '2026-09-18', discovery: makeDiscovery(), candidatesCount: 0, footer: footer(), analysedProjects: 2,
    });
    expect(quiet.headline).to.equal('All quiet: 2 projects and 3 panels checked, no candidates');
    expect(quiet.checked.projects).to.equal(2);
    const degraded = buildDeterministicBrief({
      runId: '2026-09-18', candidates: [makeCandidate()], discovery: makeDiscovery(), reason: 'r', footer: footer(),
      analysedProjects: 1,
    });
    expect(degraded.checked.projects).to.equal(1);
  });
});
