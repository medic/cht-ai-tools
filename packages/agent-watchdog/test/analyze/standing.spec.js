// Standing conditions (FR-013, FR-014, revision 23): high-rule candidates whose condition already held the previous
// day are handed to no session; code names them.
const {
  STANDING_RULES, isStanding, splitStanding, standingRecords, standingNotices, darkHostsOf,
} = require('../../src/analyze/standing');

const project = { url: 'https://north-a.example.org', host: 'north-a.example.org' };
const PANEL_REF = { dashboard_uid: 'oa2OfL-Vk', panel_id: 2, panel_title: 'Outbound Push Backlog', ref_id: 'A' };
const backlog = (previous, current = 1234) => ({
  candidate_id: 'b'.repeat(12), project_url: project.url, metric: 'cht_outbound_push_backlog_count',
  panel_ref: PANEL_REF,
  rule: 'backlog_absolute', observed: current, severity_floor: 'high', threshold: { source: 'default', value: 0 },
  evidence: [
    { window: 'current', value: current, unit: 'count' },
    ...(previous === undefined ? [] : [{ window: 'previous_day', value: previous, unit: 'count' }]),
  ],
  expected_load_window_id: null,
});
const targetDown = () => ({
  candidate_id: 'd'.repeat(12), project_url: project.url, metric: 'up{job="cht"}', rule: 'target_down', observed: 0,
  severity_floor: 'high', threshold: { source: 'default', value: 0 },
  evidence: [{ window: 'current', value: 0, unit: 'count' }], expected_load_window_id: null,
});
const upChange = (previous, trailingMean = 0) => ({
  metric: 'up{job="cht"}', current_value: 0, previous_day_value: previous, trailing_mean: trailingMean,
});
const monotonic = () => ({ ...backlog(10), candidate_id: 'm'.repeat(12), rule: 'monotonic', observed: 7 });

describe('analyze/standing', () => {
  it('names the two high rules that can stand', () => {
    expect(STANDING_RULES).to.deep.equal(['backlog_absolute', 'target_down']);
  });

  it('a backlog above zero yesterday as well is standing; zero, absent or unknown yesterday is not', () => {
    expect(isStanding(backlog(1200), [])).to.equal(true);
    expect(isStanding(backlog(0), [])).to.equal(false);
    expect(isStanding(backlog(null), [])).to.equal(false);
    expect(isStanding(backlog(undefined), [])).to.equal(false);
  });

  it('a scrape target dark yesterday and throughout the trailing fortnight is standing; a newer outage is not', () => {
    expect(isStanding(targetDown(), [upChange(0, 0)])).to.equal(true);
    // Down since yesterday but up for most of the fortnight: an outage in its second day, news for the model.
    expect(isStanding(targetDown(), [upChange(0, 0.93)])).to.equal(false);
    expect(isStanding(targetDown(), [upChange(1, 0)])).to.equal(false);
    expect(isStanding(targetDown(), [upChange(null, 0)])).to.equal(false);
    expect(isStanding(targetDown(), [upChange(0, null)])).to.equal(false);
    expect(isStanding(targetDown(), [])).to.equal(false);
  });

  it('every other rule goes to the model, whatever its history', () => {
    expect(isStanding(monotonic(), [upChange(0)])).to.equal(false);
    const { forModel, standing } = splitStanding({
      candidates: [backlog(1200), monotonic(), targetDown()], changes: [upChange(0)],
    });
    expect(forModel.map((c) => c.rule)).to.deep.equal(['monotonic']);
    expect(standing.map((c) => c.rule)).to.deep.equal(['backlog_absolute', 'target_down']);
  });

  it('records a standing condition with its rule, project, host, group and values', () => {
    const records = standingRecords({
      candidates: [backlog(1200), targetDown()], changes: [upChange(0)], project, groupOf: () => 'North Programme',
    });
    expect(records).to.deep.equal([
      {
        rule: 'backlog_absolute', project_url: project.url, host: 'north-a.example.org', group: 'North Programme',
        metric: 'cht_outbound_push_backlog_count', value: 1234, previous_day_value: 1200, panel_ref: PANEL_REF,
      },
      {
        rule: 'target_down', project_url: project.url, host: 'north-a.example.org', group: 'North Programme',
        metric: 'up{job="cht"}', value: 0, previous_day_value: 0, panel_ref: null,
      },
    ]);
    expect(darkHostsOf(records)).to.deep.equal(['north-a.example.org']);
  });

  it('writes one line per rule, grouped by programme with the count out of its size and the largest value', () => {
    const records = [
      ...['a', 'b', 'c'].map((n) => ({
        rule: 'backlog_absolute', project_url: `https://north-${n}.example.org`, host: `north-${n}.example.org`,
        group: 'North Programme', metric: 'cht_outbound_push_backlog_count', value: n === 'b' ? 5000 : 12,
        previous_day_value: 10,
      })),
      {
        rule: 'backlog_absolute', project_url: 'https://south-a.example.org', host: 'south-a.example.org',
        group: 'South Programme', metric: 'cht_outbound_push_backlog_count', value: 7, previous_day_value: 7,
      },
      {
        rule: 'target_down', project_url: 'https://dead.example.org', host: 'dead.example.org', group: 'Other',
        metric: 'up{job="cht"}', value: 0, previous_day_value: 0,
      },
    ];
    const lines = standingNotices({ records, groupSizes: { 'North Programme': 4, 'South Programme': 1 } });
    expect(lines).to.deep.equal([
      'Standing: outbound push backlog above zero on 4 projects as yesterday (North Programme 3 of 4, '
      + 'South Programme 1 of 1); largest north-b.example.org 5,000',
    ]);
    expect(standingNotices({ records: [records[0]], groupSizes: {} })).to.deep.equal([
      'Standing: outbound push backlog above zero on 1 project as yesterday (North Programme 1 of 1); '
      + 'largest north-a.example.org 12',
    ]);
    expect(standingNotices({ records: [], groupSizes: {} })).to.deep.equal([]);
  });
});

describe('analyze/standing: yesterday is the computed change\'s, never the cycle baseline (revision 34)', () => {
  const cycleBacklog = () => ({
    ...backlog(undefined),
    // During an expected-load window the candidate's baseline evidence is the previous cycle, not yesterday.
    evidence: [
      { window: 'current', value: 1234, unit: 'count' },
      { window: 'previous_cycle', value: 1200, unit: 'count' },
    ],
    expected_load_window_id: 'month-end',
  });
  const backlogChange = (previousDay) => ({
    metric: 'cht_outbound_push_backlog_count', current_value: 1234, previous_day_value: previousDay,
    previous_cycle_value: 1200, baseline: 'previous_cycle',
  });

  it('a backlog that was zero yesterday is news for the model, whatever it was a cycle ago', () => {
    expect(isStanding(cycleBacklog(), [backlogChange(0)])).to.equal(false);
    expect(isStanding(cycleBacklog(), [backlogChange(null)])).to.equal(false);
    expect(isStanding(cycleBacklog(), [])).to.equal(false);
  });

  it('a backlog above zero yesterday is standing, and the record carries yesterday\'s value from the change', () => {
    expect(isStanding(cycleBacklog(), [backlogChange(50)])).to.equal(true);
    const [record] = standingRecords({
      candidates: [cycleBacklog()], changes: [backlogChange(50)], project, groupOf: () => 'Other',
    });
    expect(record).to.include({ rule: 'backlog_absolute', value: 1234, previous_day_value: 50 });
  });
});
