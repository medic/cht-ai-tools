// FR-065: category and importance from alerts.yaml, unknown titles uncategorised and medium, staleness after the
// configured days, newness against the previous run.
const { classifyAlerts, importanceOf, UNCATEGORISED, deadHostsFromDiscovery } = require('../../src/alerts/classify');
const { rule, instance, alertsPolicy, PROJECT_GROUPS, RUN_START } = require('../helpers/alerts');

const runStart = new Date(RUN_START);

const DEFAULT_RULES = ['sentinel', 'outbound', 'apiDown', 'fragmentation', 'unknown', 'watchdog'];
const collectedWith = (instances, rules = DEFAULT_RULES) => ({
  available: true, reason: null, fetched_at: RUN_START, source: 'rules', rules: rules.map((r) => rule(r)), instances,
  ignored: [], raw: [],
});

describe('alerts/classify importanceOf', () => {
  it('reads category and importance by title and falls back to uncategorised, medium, unknown', () => {
    const policy = alertsPolicy();
    expect(importanceOf('API Server Down', policy))
      .to.deep.equal({ category: 'availability', importance: 'critical', known: true });
    expect(importanceOf('DB Fragmentation', policy))
      .to.deep.equal({ category: 'database', importance: 'low', known: true });
    expect(importanceOf('Disk Usage High', policy))
      .to.deep.equal({ category: UNCATEGORISED, importance: 'medium', known: false });
    expect(UNCATEGORISED).to.equal('uncategorised');
  });
});

describe('alerts/classify classifyAlerts', () => {
  const instances = [
    instance('sentinel', 'north-a.example.org'),
    instance('sentinel', 'north-b.example.org', { active_at: '2026-08-20T00:00:00Z' }),
    instance('outbound', 'north-b.example.org', { active_at: '2026-09-04T06:00:00Z' }),
    instance('apiDown', 'north-b.example.org', { active_at: '2026-09-18T05:00:00Z' }),
    instance('delivery', 'south-a.example.org'),
    instance('unknown', 'north-a.example.org'),
    instance('watchdog', null),
    instance('fragmentation', 'other.example.org', { active_at: null }),
    instance('fragmentation', 'pending.example.org', { state: 'pending' }),
  ];
  const classify = (previous = null, overrides = {}) => classifyAlerts({
    collected: collectedWith(instances), alertsPolicy: alertsPolicy(), projectGroups: PROJECT_GROUPS, previous,
    runStart, ...overrides,
  });

  it('measures days firing from the time the alerts were read, not the run start, and records it', () => {
    // A forced re-run of 2026-09-18 the next evening: the snapshot is live, so ages count from the snapshot.
    const late = instance('sentinel', 'north-a.example.org', { active_at: '2026-09-18T15:00:00Z' });
    const old = instance('outbound', 'north-b.example.org', { active_at: '2026-09-05T18:00:00Z' });
    const out = classifyAlerts({
      collected: { ...collectedWith([late, old]), fetched_at: '2026-09-19T17:56:00Z' },
      alertsPolicy: alertsPolicy(), projectGroups: PROJECT_GROUPS, previous: null, runStart,
    });
    expect(out.observed_at).to.equal('2026-09-19T17:56:00.000Z');
    const byHost = Object.fromEntries(out.instances.map((i) => [i.host, i]));
    expect(byHost['north-a.example.org']).to.include({ days_firing: 1, new: true, stale: false });
    expect(byHost['north-b.example.org']).to.include({ days_firing: 13, stale: false });
    // An explicit observation time wins over the file's, and the run start stands in when the file has none.
    const explicit = classifyAlerts({
      collected: collectedWith([old]), alertsPolicy: alertsPolicy(), projectGroups: PROJECT_GROUPS, runStart,
      observedAt: '2026-09-20T06:00:00Z',
    });
    expect(explicit.observed_at).to.equal('2026-09-20T06:00:00.000Z');
    expect(explicit.instances[0]).to.include({ days_firing: 14, stale: true });
    const { fetched_at: ignored, ...withoutTime } = collectedWith([old]);
    void ignored;
    const fallback = classifyAlerts({
      collected: withoutTime, alertsPolicy: alertsPolicy(), projectGroups: PROJECT_GROUPS, runStart,
    });
    expect(fallback.observed_at).to.equal(runStart.toISOString());
    expect(fallback.instances[0].days_firing).to.equal(12);
  });

  it('lists the ignored hosts once and derives dead hosts from the discovery targets (revision 17)', () => {
    const ignored = [
      { host: 'training-1.south.example.org', pattern: 'training-*', title: 'Sentinel Backlog' },
      { host: 'training-1.south.example.org', pattern: 'training-*', title: 'API Server Down' },
      { host: 'cht-dev.example.org', pattern: '*-dev.*', title: 'Sentinel Backlog' },
    ];
    const out = classify(null, { collected: { ...collectedWith(instances), ignored } });
    expect(out.ignored_hosts).to.deep.equal(['cht-dev.example.org', 'training-1.south.example.org']);
    expect(classify().ignored_hosts).to.deep.equal([]);
    const unavailable = classifyAlerts({
      collected: { available: false, reason: 'HTTP 503', rules: [], instances: [], ignored },
      alertsPolicy: alertsPolicy(), projectGroups: PROJECT_GROUPS, previous: null, runStart,
    });
    expect(unavailable.ignored_hosts).to.deep.equal(['cht-dev.example.org', 'training-1.south.example.org']);

    const discovery = {
      scrape_target_metric: 'up{job="cht"}',
      projects: [
        { host: 'dead.example.org', scrape_targets: [{ job: 'cht', health: 'down' }, { job: 'other', health: 'up' }] },
        { host: 'alive.example.org', scrape_targets: [{ job: 'cht', health: 'up' }] },
        { host: 'express.example.org', scrape_targets: [{ job: 'cht-express-metrics', health: 'down' }] },
        { host: 'unknown.example.org', scrape_targets: [] },
      ],
    };
    expect([...deadHostsFromDiscovery(discovery)]).to.deep.equal(['dead.example.org']);
    expect([...deadHostsFromDiscovery({ projects: [] })]).to.deep.equal([]);
    expect([...deadHostsFromDiscovery(null)]).to.deep.equal([]);
  });

  it('classifies every instance with category, importance, known, group, started_at, days_firing and stale', () => {
    const out = classify();
    expect(out.available).to.equal(true);
    expect(out.stale_after_days).to.equal(14);
    const byHostTitle = (host, title) => out.instances.find((i) => i.host === host && i.title === title);
    const northA = byHostTitle('north-a.example.org', 'Sentinel Backlog');
    expect(northA).to.include({
      category: 'backlog', importance: 'high', known: true, group: 'North Programme',
      started_at: '2026-09-17T20:00:00Z',
      days_firing: 0, stale: false, new: true, state: 'firing',
    });
    const stale = byHostTitle('north-b.example.org', 'Sentinel Backlog');
    expect(stale).to.include({ days_firing: 29, stale: true });
    // Exactly the threshold counts as stale.
    expect(byHostTitle('north-b.example.org', 'Outbound Push Backlog')).to.include({ days_firing: 14, stale: true });
    expect(byHostTitle('north-b.example.org', 'API Server Down'))
      .to.include({ importance: 'critical', category: 'availability' });
    expect(byHostTitle('south-a.example.org', 'Message Delivery Rate'))
      .to.include({ group: 'South Programme', category: 'messaging' });
    const unknown = byHostTitle('north-a.example.org', 'Disk Usage High');
    expect(unknown).to.include({ category: 'uncategorised', importance: 'medium', known: false });
    const watchdog = out.instances.find((i) => i.title === 'Watchdog Scrape Failures');
    expect(watchdog).to.include({ group: 'Watchdog', host: null });
    expect(byHostTitle('other.example.org', 'DB Fragmentation')).to.include({ group: 'Other' });
  });

  it('takes started_at from activeAt, else from the previous run, else from this run start', () => {
    const noActiveAt = instances.find((i) => i.host === 'other.example.org');
    const first = classify();
    expect(first.instances.find((i) => i.instance_id === noActiveAt.instance_id).started_at)
      .to.equal(runStart.toISOString());
    const previous = {
      instances: [{ instance_id: noActiveAt.instance_id, state: 'firing', started_at: '2026-09-10T06:00:00Z' }],
    };
    const second = classify(previous);
    const carried = second.instances.find((i) => i.instance_id === noActiveAt.instance_id);
    expect(carried).to.include({ started_at: '2026-09-10T06:00:00Z', days_firing: 8, new: false });
  });

  it('marks new against the previous run and counts firing instances only', () => {
    const previous = {
      instances: instances.slice(0, 2)
        .map((i) => ({ instance_id: i.instance_id, state: 'firing', started_at: i.active_at })),
    };
    const out = classify(previous);
    expect(out.instances.filter((i) => i.state === 'firing' && !i.new).map((i) => i.instance_id).sort())
      .to.deep.equal(instances.slice(0, 2).map((i) => i.instance_id).sort());
    expect(out.instances.find((i) => i.state === 'pending')).to.include({ new: false, stale: false });
    expect(out.counts).to.deep.equal({ firing: 8, new: 6, stale: 2, housekeeping: 0, pending: 1, unknown_rules: 2 });
    // A pending instance is stored but never grouped.
    expect(out.groups.flatMap((g) => g.instance_ids)).to.not.include(instances[8].instance_id);
  });

  it('carries the rules with their classification and honours another staleness threshold', () => {
    const out = classify(null, { alertsPolicy: { ...alertsPolicy(), stale_after_days: 30 } });
    expect(out.stale_after_days).to.equal(30);
    expect(out.instances.filter((i) => i.stale)).to.deep.equal([]);
    const sentinelRule = out.rules.find((r) => r.title === 'Sentinel Backlog');
    expect(sentinelRule).to.include({ category: 'backlog', importance: 'high', known: true });
    expect(out.rules.find((r) => r.title === 'Disk Usage High'))
      .to.include({ category: 'uncategorised', known: false });
  });

  it('attaches evidence, marks stale alerts on dead hosts as housekeeping, sizes patterns (FR-079, FR-080)', () => {
    const changesByProject = new Map([
      ['https://north-a.example.org', [
        { metric: 'cht_sentinel_backlog_count', aggregate: 'level', current_value: 912, previous_day_value: 300,
          pct_change_vs_previous_day: 204 },
        { metric: 'cht_sentinel_backlog_count >= 0', aggregate: 'level', current_value: 1, previous_day_value: 1,
          pct_change_vs_previous_day: 0 },
      ]],
    ]);
    const out = classifyAlerts({
      collected: collectedWith([
        instance('sentinel', 'north-a.example.org'),
        instance('apiDown', 'north-b.example.org', { active_at: '2026-07-01T00:00:00Z' }),
        instance('sentinel', 'north-b.example.org', { active_at: '2026-08-20T00:00:00Z' }),
      ]),
      alertsPolicy: alertsPolicy(), projectGroups: PROJECT_GROUPS, runStart,
      changesByProject, categories: alertsPolicy().categories,
      deadHosts: new Set(['north-b.example.org']), groupSizes: { 'North Programme': 3 },
    });
    const withEvidence = out.instances.find((i) => i.host === 'north-a.example.org');
    expect(withEvidence.evidence).to.deep.equal({
      metric: 'cht_sentinel_backlog_count', aggregate: 'level', current_value: 912, previous_day_value: 300,
      pct_change_vs_previous_day: 204,
    });
    const dead = out.instances.find((i) => i.title === 'API Server Down');
    expect(dead).to.include({ housekeeping: true, stale: true });
    expect(out.instances.find((i) => i.host === 'north-b.example.org' && i.title === 'Sentinel Backlog').housekeeping)
      .to.equal(true);
    expect(out.housekeeping.map((h) => [h.title, h.host])).to.deep.equal([
      ['API Server Down', 'north-b.example.org'], ['Sentinel Backlog', 'north-b.example.org'],
    ]);
    expect(out.counts).to.include({ firing: 1, housekeeping: 2 });
    expect(out.groups.map((g) => g.alert_key)).to.deep.equal(['North Programme/backlog']);
    expect(out.groups[0].firing).to.equal(1);
    expect(out.groups[0].patterns).to.deep.equal([]);
    expect(out.groups[0].instances[0].evidence.metric).to.equal('cht_sentinel_backlog_count');
  });

  it('passes an unavailable collection through with empty instances and groups', () => {
    const out = classifyAlerts({
      collected: { available: false, reason: 'HTTP 503', rules: [], instances: [], ignored: [] },
      alertsPolicy: alertsPolicy(), projectGroups: PROJECT_GROUPS, previous: null, runStart,
    });
    expect(out).to.include({ available: false, reason: 'HTTP 503' });
    expect(out.instances).to.deep.equal([]);
    expect(out.groups).to.deep.equal([]);
  });
});
