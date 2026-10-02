// Engine parity (US3 scenario 7, smoke tests S-3 and S-10): the two engines must produce the same items and gate
// verdicts for one recorded project. Only the pure comparison is unit-tested; the smoke script itself needs
// credentials.
const { normaliseFindings, diffEngines } = require('../../smoke/agent-parity');

const item = (overrides = {}) => ({
  item_id: 'abcdefabcdef',
  project_url: 'https://alpha.example.org',
  metric: 'cht_sentinel_backlog_count',
  severity: 'high',
  evidence: [
    { window: 'previous_day', value: 300.4567, unit: 'count' },
    { window: 'current', value: 912.0004, unit: 'count' },
  ],
  why_now: 'worded one way',
  suggested_check: 'worded another way',
  dashboard_ref: {
    dashboard_uid: 'oa2OfL-Vk', panel_id: 3, project_url: 'https://alpha.example.org',
    from: '2026-09-17T06:00:00Z', to: '2026-09-18T06:00:00Z',
  },
  confidence: 0.85,
  persisting_days: 1,
  pattern_card: null,
  candidate_ids: ['b', 'a'],
  reference_urls: ['https://docs.communityhealthtoolkit.org/b', 'https://docs.communityhealthtoolkit.org/a'],
  rank: null,
  placement: null,
  pass_history: [],
  ...overrides,
});

const pass = (n, items, outcome = 'accepted', failing = []) => ({
  pass: n,
  session_id: 's',
  items,
  not_selected: [],
  changes: [],
  converged: false,
  gate: {
    subject: 'pass', subject_ref: `alpha-example-org/pass${n}`, attempt: 1, outcome,
    checks: [
      { name: 'schema', status: 'pass', reasons: [] },
      ...failing.map((name) => ({ name, status: 'fail', reasons: ['x'] })),
    ],
  },
  usage: null,
  cost_usd: 0.01,
  num_turns: 3,
  duration_ms: 100,
  tool_calls_path: 'alpha-example-org/tool-calls.jsonl',
});

describe('smoke/agent-parity comparison', () => {
  it('normalises a pass to identity, severity, rounded sorted evidence and gate verdict, dropping prose', () => {
    const normalised = normaliseFindings(pass(1, [item()], 'rejected', ['numbers_match']));
    expect(normalised.pass).to.equal(1);
    expect(normalised.items).to.have.length(1);
    const [first] = normalised.items;
    expect(first.item_key).to.deep.equal({ metric: 'cht_sentinel_backlog_count', pattern_card: null });
    expect(first.severity).to.equal('high');
    expect(first.evidence).to.deep.equal([
      { window: 'current', value: 912, unit: 'count' },
      { window: 'previous_day', value: 300, unit: 'count' },
    ]);
    expect(first.candidate_ids).to.deep.equal(['a', 'b']);
    expect(first.reference_urls).to.deep.equal([
      'https://docs.communityhealthtoolkit.org/a', 'https://docs.communityhealthtoolkit.org/b',
    ]);
    expect(first.dashboard_ref).to.deep.equal({ dashboard_uid: 'oa2OfL-Vk', panel_id: 3 });
    expect(first).to.not.have.any.keys('why_now', 'suggested_check', 'confidence', 'item_id');
    expect(normalised.gate).to.deep.equal({ outcome: 'rejected', failing: ['numbers_match'] });
  });

  it('treats differently worded but otherwise identical passes as the same', () => {
    const sdk = { engine: 'sdk', passes: [normaliseFindings(pass(1, [item()]))] };
    const cli = {
      engine: 'cli',
      passes: [normaliseFindings(pass(1, [item({ why_now: 'other words', evidence: [
        { window: 'current', value: 912.0002, unit: 'count' },
        { window: 'previous_day', value: 300.4999, unit: 'count' },
      ] })]))],
    };
    expect(diffEngines(sdk, cli)).to.deep.equal({ same: true, differences: [] });
  });

  it('names every difference: pass count, items, severity and gate verdict', () => {
    const sdk = {
      engine: 'sdk',
      passes: [normaliseFindings(pass(1, [item()])), normaliseFindings(pass(2, [item()]))],
    };
    const cli = {
      engine: 'cli',
      passes: [normaliseFindings(pass(1, [
        item({ severity: 'low' }),
        item({ metric: 'cht_conflict_count', item_id: '0123456789ab' }),
      ], 'rejected', ['severity_rules']))],
    };
    const diff = diffEngines(sdk, cli);
    expect(diff.same).to.equal(false);
    const text = diff.differences.join('\n');
    expect(text).to.match(/pass count/);
    expect(text).to.match(/pass 1.*only in cli.*cht_conflict_count/);
    expect(text).to.match(/pass 1.*cht_sentinel_backlog_count.*differs/);
    expect(text).to.match(/pass 1 gate: sdk accepted vs cli rejected \(severity_rules\)/);
  });
});
