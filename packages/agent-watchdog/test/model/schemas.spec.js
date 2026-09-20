const { schemas, enums } = require('../../src/model/schemas');

describe('model/schemas', () => {
  it('rejects unknown enumeration values', () => {
    expect(() => enums.Severity.parse('urgent')).to.throw();
    expect(() => enums.WindowName.parse('last_month')).to.throw();
    expect(() => enums.RunStatus.parse('done')).to.throw();
    expect(() => enums.CandidateRule.parse('spike')).to.throw();
    expect(() => enums.FeedbackVerdict.parse('meh')).to.throw();
    expect(enums.RunStatus.options).to.include.members([
      'created', 'collected', 'analysed', 'drafted', 'verified', 'degraded', 'rendered', 'published', 'heartbeat',
      'previewed', 'unposted', 'failed', 'refused',
    ]);
    expect(enums.CandidateRule.options).to.deep.equal(
      ['pct_change', 'deviation', 'monotonic', 'target_down', 'backlog_absolute'],
    );
  });

  it('validates a Project with a derived url and rejects a URL as identity', () => {
    const project = schemas.Project.parse({ host: 'cht.example.org', url: 'https://cht.example.org', slug: 'cht-example-org', configured: false, owner: null, notes: null, thresholds: null, expected_load_windows: [], cht_version: null, history_days: 3, scrape_targets: [] });
    expect(project.host).to.equal('cht.example.org');
    expect(() => schemas.Project.parse({ ...project, host: 'https://cht.example.org' })).to.throw();
  });

  it('validates an Item and rejects an out-of-range confidence or a missing candidate list', () => {
    const item = {
      item_id: 'abcdefabcdef', project_url: 'https://cht.example.org', metric: 'cht_sentinel_backlog_count', severity: 'high',
      evidence: [
        { window: 'current', value: 900, unit: 'count', start: '2026-09-17T06:00:00Z', end: '2026-09-18T06:00:00Z' },
      ],
      why_now: 'w', suggested_check: 's', dashboard_ref: { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, project_url: 'https://cht.example.org', from: '2026-09-17T06:00:00Z', to: '2026-09-18T06:00:00Z' },
      confidence: 0.8, persisting_days: 1, pattern_card: null, candidate_ids: ['c1'], reference_urls: [], rank: 1,
      placement: 'body', pass_history: [],
    };
    expect(schemas.Item.parse(item).item_id).to.equal('abcdefabcdef');
    expect(() => schemas.Item.parse({ ...item, confidence: 1.5 })).to.throw();
    expect(() => schemas.Item.parse({ ...item, candidate_ids: [] })).to.throw();
    expect(() => schemas.Item.parse({ ...item, item_id: 'short' })).to.throw();
  });

  it('validates a Brief with at most five bullets of at most eight sub-bullets (FR-010, FR-015)', () => {
    const bullet = (i) => ({ item_id: `${i}`.padStart(12, 'a'), text: 'one line' });
    const brief = { run_id: '2026-09-18', kind: 'brief', headline: 'h', bullets: [1, 2, 3, 4, 5].map(bullet), expected_load_notice: null, checked: { projects: 1, panels: 2, candidates: 3 }, degradation_notice: null, image: null, footer: { prompts_url: 'https://a', config_url: 'https://b', trace_url: 'https://c', cost_usd: 0.12 }, publication: null };
    const parsed = schemas.Brief.parse(brief);
    expect(parsed.bullets).to.have.length(5);
    // A bare { item_id, text } bullet is an item bullet with no sub-bullets.
    expect(parsed.bullets[0]).to.deep.equal({
      kind: 'item', item_id: bullet(1).item_id, group: null, text: 'one line', children: [], alert_key: null,
    });
    expect(() => schemas.Brief.parse({ ...brief, bullets: [1, 2, 3, 4, 5, 6].map(bullet) })).to.throw();
    expect(() => schemas.Brief.parse({ ...brief, kind: 'degraded', degradation_notice: null })).to.throw();
    const child = (i) => ({ item_id: `${i}`.padStart(12, 'b'), text: 'sub' });
    const group = {
      kind: 'group', item_id: null, group: 'MoH Nepal', text: 'MoH Nepal: 8 projects with issues',
      children: [1, 2, 3, 4, 5, 6, 7, 8].map(child), alert_key: null,
    };
    expect(schemas.Brief.parse({ ...brief, bullets: [group] }).bullets[0].children).to.have.length(8);
    expect(() => schemas.Brief.parse({ ...brief, bullets: [{ ...group, children: [...group.children, child(9)] }] }))
      .to.throw();
    expect(() => schemas.Brief.parse({ ...brief, bullets: [{ ...group, group: null }] })).to.throw();
    expect(() => schemas.Brief.parse({ ...brief, bullets: [{ ...group, kind: 'item', item_id: null }] })).to.throw();
    expect(() => enums.BulletKind.parse('list')).to.throw();
  });

  it('gives a Project its group label and an Item its body slot (FR-068, FR-069)', () => {
    const project = schemas.Project.parse({ host: 'nepal-a.example.org', url: 'https://nepal-a.example.org', slug: 'nepal-a-example-org', configured: false, owner: null, notes: null, thresholds: null, expected_load_windows: [], cht_version: null, history_days: 3, scrape_targets: [], group: 'MoH Nepal' });
    expect(project.group).to.equal('MoH Nepal');
    const withoutGroup = { ...project };
    delete withoutGroup.group;
    expect(schemas.Project.parse(withoutGroup).group).to.equal('Other');
    expect(() => schemas.Project.parse({ ...project, group: '' })).to.throw();
    const item = {
      item_id: 'abcdefabcdef', project_url: 'https://cht.example.org', metric: 'cht_sentinel_backlog_count', severity: 'high',
      evidence: [], why_now: 'w', suggested_check: 's', dashboard_ref: { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, project_url: 'https://cht.example.org', from: '2026-09-17T06:00:00Z', to: '2026-09-18T06:00:00Z' },
      confidence: 0.8, persisting_days: 1, pattern_card: null, candidate_ids: ['c1'], reference_urls: [], rank: 1,
      placement: 'body', pass_history: [],
    };
    expect(schemas.Item.parse(item).slot).to.equal(null);
    expect(schemas.Item.parse({ ...item, slot: 5 }).slot).to.equal(5);
    expect(() => schemas.Item.parse({ ...item, slot: 6 })).to.throw();
    expect(() => schemas.Item.parse({ ...item, slot: 0 })).to.throw();
  });

  it('validates Feedback and requires an item id when the target is an item', () => {
    const fb = {
      feedback_id: 'abcdefabcdef', date: '2026-09-18', run_id: '2026-09-17', target: 'item', item_id: 'abcdefabcdef',
      kind: 'reaction', verdict: 'up', note: null, horizon: null, author: 'U1', matched: true, source_ts: '1.2',
    };
    expect(schemas.Feedback.parse(fb).verdict).to.equal('up');
    expect(() => schemas.Feedback.parse({ ...fb, item_id: null })).to.throw();
    expect(schemas.Feedback.parse({ ...fb, target: 'brief', item_id: null }).target).to.equal('brief');
  });

  it('validates a Candidate with the severity floor rule and a Computed Change with nullable fields', () => {
    const change = { project_url: 'https://a', metric: 'm', panel_ref: { dashboard_uid: 'd', panel_id: 1, panel_title: 't', ref_id: 'A' }, current_value: 10, previous_day_value: null, previous_week_value: null, previous_cycle_value: null, pct_change_vs_previous_day: null, trailing_mean: null, trailing_stddev: null, deviation_sigma: null, monotonic_rise_hours: 0, baseline: 'previous_day', expected_load_window_id: null };
    expect(schemas.ComputedChange.parse(change).monotonic_rise_hours).to.equal(0);
    const candidate = { candidate_id: 'abcdefabcdef', project_url: 'https://a', metric: 'm', panel_ref: change.panel_ref, rule: 'target_down', threshold: { source: 'default', value: 0 }, observed: 0, severity_floor: 'high', evidence: [], expected_load_window_id: null };
    expect(schemas.Candidate.parse(candidate).rule).to.equal('target_down');
    expect(() => schemas.Candidate.parse({ ...candidate, threshold: { source: 'guess', value: 0 } })).to.throw();
  });

  it('exposes every entity named in the data model', () => {
    const names = [
      'Project', 'Run', 'MetricWindow', 'ComputedChange', 'Candidate', 'Item', 'Pass', 'VerificationReport', 'Brief',
      'ThreadReply', 'Feedback', 'MemoryMeta', 'Proposal', 'CorpusItem', 'PatternCard', 'CalibrationReport',
      'ExpectedLoadWindow', 'PriorityList', 'CostRecord',
    ];
    for (const name of names) {
      expect(schemas[name], name).to.exist;
    }
  });
});

describe('model/schemas: alert entities (User Story 8)', () => {
  const { rule, classified, groupOf } = require('../helpers/alerts');

  it('validates an Alert Rule, an Alert Instance, an Alert Group and an Alert Episode event', () => {
    const ruleRecord = { ...rule('sentinel'), category: 'backlog', importance: 'high', known: true };
    expect(schemas.AlertRule.parse(ruleRecord).rule_uid).to.equal('FzCrECYVk');
    expect(() => schemas.AlertRule.parse({ ...ruleRecord, importance: 'urgent' })).to.throw();
    const instance = classified('sentinel', 'nepal-a.example.org');
    expect(schemas.AlertInstance.parse(instance).state).to.equal('firing');
    expect(() => schemas.AlertInstance.parse({ ...instance, state: 'Alerting' })).to.throw();
    expect(schemas.AlertInstance.parse(classified('watchdog', null)).host).to.equal(null);
    const group = groupOf([instance]);
    expect(schemas.AlertGroup.parse(group).alert_key).to.equal('MoH Nepal/backlog');
    const event = {
      episode_id: 'e'.repeat(12), event: 'opened', run_id: '2026-09-18', at: '2026-09-18T06:00:00Z',
      instance_id: instance.instance_id, rule_uid: instance.rule_uid, title: instance.title, host: instance.host,
      project_url: instance.project_url, group: 'MoH Nepal', category: 'backlog', importance: 'high',
      started_at: instance.started_at, cleared_at: null, duration_hours: null,
      correlations: { expected_load_window_id: null, version_change: null, related_candidates: [], related_items: [] },
      explanation: null,
    };
    expect(schemas.AlertEpisode.parse(event).event).to.equal('opened');
    expect(() => schemas.AlertEpisode.parse({ ...event, event: 'seen' })).to.throw();
    expect(enums.AlertState.options).to.deep.equal(['firing', 'pending', 'nodata', 'error', 'normal']);
    expect(enums.AlertImportance.options).to.deep.equal(['critical', 'high', 'medium', 'low']);
  });

  it('lets Feedback and a Thread Reply target an alert group by key', () => {
    const fb = {
      feedback_id: 'abcdefabcdef', date: '2026-09-18', run_id: '2026-09-17', target: 'alert_group', item_id: null,
      alert_key: 'MoH Nepal/backlog', kind: 'reaction', verdict: 'down', note: null, horizon: null, author: 'U1',
      matched: true, source_ts: '1.2',
    };
    expect(schemas.Feedback.parse(fb).alert_key).to.equal('MoH Nepal/backlog');
    expect(() => schemas.Feedback.parse({ ...fb, alert_key: null })).to.throw();
    expect(schemas.Feedback.parse({ ...fb, target: 'brief', alert_key: null }).alert_key).to.equal(null);
    const reply = { item_id: null, alert_key: 'MoH Nepal/backlog', run_id: '2026-09-18', text: 't', publication: null };
    expect(schemas.ThreadReply.parse(reply).alert_key).to.equal('MoH Nepal/backlog');
    expect(() => schemas.ThreadReply.parse({ ...reply, alert_key: null })).to.throw();
  });
});
