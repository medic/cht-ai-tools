const { buildDigest, DIGEST_EVENT, effectFor } = require('../../src/publish/digest');
const { makeItem } = require('../rollup/factories');

const record = (overrides = {}) => ({
  feedback_id: 'f1f1f1f1f1f1',
  date: '2026-09-19',
  run_id: '2026-09-18',
  target: 'item',
  item_id: 'aaaaaaaaaaaa',
  kind: 'reaction',
  verdict: 'down',
  note: null,
  horizon: null,
  author: 'U0123ABCD',
  matched: true,
  source_ts: '1700000000.000100',
  acknowledged_run_id: null,
  classification: null,
  proposal_id: null,
  ...overrides,
});

const RETENTION = { records_path: '/data/feedback.jsonl', influence_days: 30 };

describe('publish/digest (FR-062)', () => {
  const alpha = makeItem({ item_id: 'aaaaaaaaaaaa' });
  const gamma = makeItem({ item_id: 'bbbbbbbbbbbb', project_url: 'https://gamma.example.org', metric: 'up{job="cht"}' });
  const byItem = {
    aaaaaaaaaaaa: { project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count', up: 0, down: 1 },
    bbbbbbbbbbbb: { project_url: 'https://gamma.example.org', metric: 'up{job="cht"}', up: 2, down: 0 },
  };
  const records = [
    record(),
    record({
      feedback_id: 'f2f2f2f2f2f2', kind: 'note', verdict: null, horizon: '2026-10-01', source_ts: '1700000000.000200',
      note: 'known migration until 1 October, ask <@U0123ABCD>',
    }),
    record({ feedback_id: 'f3f3f3f3f3f3', item_id: 'bbbbbbbbbbbb', verdict: 'up', author: 'U1', source_ts: '1.3' }),
    record({ feedback_id: 'f4f4f4f4f4f4', item_id: 'bbbbbbbbbbbb', verdict: 'up', author: 'U2', source_ts: '1.4' }),
    record({ feedback_id: 'f5f5f5f5f5f5', target: 'brief', item_id: null, verdict: 'up', source_ts: '1.0' }),
    record({
      feedback_id: 'f6f6f6f6f6f6', target: 'brief', item_id: null, kind: 'note', verdict: null, matched: false,
      note: 'is anyone looking at <the other one>? cc U0123ABCD', source_ts: '1700000000.000400',
    }),
  ];
  const review = {
    classified: [{
      feedback_id: 'f2f2f2f2f2f2', item_id: 'aaaaaaaaaaaa', classification: 'project_annotation',
      proposal_id: '2026-09-19-project_annotation-sentinel-expectation',
      proposal_path: '/data/proposals/2026-09-19-project_annotation-sentinel-expectation.md',
      destination: 'projects.yaml annotation',
    }],
    unclassified: ['f6f6f6f6f6f6'],
  };
  const build = (overrides = {}) => buildDigest({
    runId: '2026-09-19', date: '2026-09-19', records, byItem, items: [alpha, gamma],
    adjustments: [{ item_id: 'bbbbbbbbbbbb', before: 0.85, after: 1, verdict: 'confirmed' }],
    suppressed: [{ candidate_id: 'c1', item_id: 'aaaaaaaaaaaa', horizon: '2026-10-01', reason: 'within expectation' }],
    review, unmatched: [{ note: 'is anyone looking at <the other one>? cc U0123ABCD' }], retention: RETENTION,
    ...overrides,
  });

  it('returns null when there is nothing to acknowledge', () => {
    const none = buildDigest({ runId: 'r', date: 'd', records: [], byItem: {}, items: [], retention: RETENTION });
    expect(none).to.equal(null);
  });

  it('builds the entity: every record acknowledged, per-item tallies and effects, brief tallies, proposals', () => {
    const { digest } = build();
    expect(digest.run_id).to.equal('2026-09-19');
    expect(digest.acknowledged.sort()).to.deep.equal(records.map((r) => r.feedback_id).sort());
    const alphaEntry = digest.items.find((i) => i.item_id === 'aaaaaaaaaaaa');
    expect(alphaEntry).to.include({
      host: 'alpha.example.org', metric: 'cht_sentinel_backlog_count', up: 0, down: 1, notes: 1,
      effect: 'suppressed', until: '2026-10-01',
    });
    const gammaEntry = digest.items.find((i) => i.item_id === 'bbbbbbbbbbbb');
    expect(gammaEntry).to.include({ host: 'gamma.example.org', up: 2, down: 0, notes: 0, effect: 'confidence_up' });
    expect(gammaEntry.before).to.equal(0.85);
    expect(gammaEntry.after).to.equal(1);
    expect(digest.brief).to.deep.equal({ up: 1, down: 0, notes: 1 });
    expect(digest.proposals).to.deep.equal([{
      proposal_id: '2026-09-19-project_annotation-sentinel-expectation', type: 'project_annotation',
      path: '/data/proposals/2026-09-19-project_annotation-sentinel-expectation.md',
    }]);
    expect(digest.unmatched).to.have.length(1);
    expect(digest.unclassified).to.equal(1);
    expect(digest.retention).to.deep.equal(RETENTION);
    expect(digest.reactions).to.deep.equal([]);
    expect(digest.publication).to.equal(null);
  });

  it('renders text and blocks that name no person, escape untrusted notes and state the retention rule', () => {
    const { text, blocks, metadata } = build();
    expect(text).to.include('Feedback from yesterday: 4 reactions, 2 notes');
    expect(text).to.include('alpha.example.org');
    expect(text).to.include('suppressed until 2026-10-01');
    expect(text).to.include('confidence raised');
    expect(text).to.include('projects.yaml annotation');
    expect(text).to.include('/data/proposals/2026-09-19-project_annotation-sentinel-expectation.md');
    expect(text).to.include('&lt;the other one&gt;');
    expect(text).to.include('1 note awaiting classification');
    expect(text).to.include('Records are kept permanently at /data/feedback.jsonl; '
      + 'feedback adjusts ranking for 30 days. Adopting a proposal makes it permanent.');
    expect(text).to.not.match(/U0123ABCD|U1\b|U2\b|<@/);
    expect(text).to.include('[person]');
    expect(blocks.length).to.be.at.least(3);
    expect(blocks.every((b) => b.type === 'section' && b.text.type === 'mrkdwn')).to.equal(true);
    expect(blocks.map((b) => b.text.text).join('\n')).to.not.match(/U0123ABCD/);
    expect(metadata).to.deep.equal({
      event_type: DIGEST_EVENT, event_payload: { run_id: '2026-09-19', date: '2026-09-19', acknowledged: 6 },
    });
  });

  it('reports no effect for an item that was neither adjusted nor suppressed and lowers when confidence fell', () => {
    expect(effectFor({ itemId: 'x', adjustments: [], suppressed: [] })).to.deep.equal({ effect: 'none', until: null });
    expect(effectFor({ itemId: 'x', adjustments: [{ item_id: 'x', before: 0.8, after: 0.65 }], suppressed: [] }))
      .to.include({ effect: 'confidence_down', before: 0.8, after: 0.65 });
    const { text } = build({ adjustments: [{ item_id: 'bbbbbbbbbbbb', before: 0.85, after: 0.7 }] });
    expect(text).to.include('confidence lowered');
  });

  it('tolerates missing optional inputs', () => {
    const { digest, text } = buildDigest({
      runId: 'r', date: 'd', records: [record()], byItem: {}, items: [alpha], retention: RETENTION,
    });
    expect(digest.items[0]).to.include({ host: 'alpha.example.org', effect: 'none' });
    expect(digest.proposals).to.deep.equal([]);
    expect(digest.unclassified).to.equal(0);
    expect(text).to.not.include('Proposals written');
  });
});

describe('publish/digest: how the feedback was used (FR-085, revision 29)', () => {
  const alpha = makeItem({ item_id: 'aaaaaaaaaaaa' });
  const gamma = makeItem({ item_id: 'bbbbbbbbbbbb', project_url: 'https://gamma.example.org', metric: 'up{job="cht"}' });
  const byItem = {
    aaaaaaaaaaaa: { project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count', up: 0, down: 1 },
    bbbbbbbbbbbb: { project_url: 'https://gamma.example.org', metric: 'up{job="cht"}', up: 1, down: 0 },
  };
  const records = [
    record({
      feedback_id: 'f2f2f2f2f2f2', kind: 'note', verdict: 'down', horizon: '2026-09-25', note: 'until 25 September',
    }),
    record({
      feedback_id: 'f3f3f3f3f3f3', item_id: 'bbbbbbbbbbbb', kind: 'note', verdict: 'up', note: '#2 👍 <@U0123ABCD>',
    }),
  ];
  const held = {
    applied: 'suppressed', prompt_path: null, records: 0, lines: [], lines_total: 0, trace_url: null,
    suppressed_until: '2026-09-25', suppressed_path: 'alpha-example-org/suppressed.json',
  };
  const quoted = {
    applied: 'prompt', prompt_path: 'gamma-example-org/prompt.pass1.md', records: 1,
    lines: ['"kind": "note",', '"verdict": "up",', '"note": "#2 👍 <@U0123ABCD>",', '"horizon": null,'], lines_total: 17,
    trace_url: 'https://langfuse.example.org/trace/t1?observation=obs1', suppressed_until: null, suppressed_path: null,
  };
  const build = (provenance, overrides = {}) => buildDigest({
    runId: '2026-09-19', date: '2026-09-19', records, byItem, items: [alpha, gamma],
    suppressed: [{ candidate_id: 'c1', item_id: 'aaaaaaaaaaaa', horizon: '2026-09-25', reason: 'r' }],
    adjustments: [{ item_id: 'bbbbbbbbbbbb', direction: 'up', after: 1 }], retention: RETENTION, provenance,
    ...overrides,
  });

  it('says per item where the feedback acted: the suppression, or the quoted prompt lines with the trace link', () => {
    const { digest, text, blocks } = build(new Map([['aaaaaaaaaaaa', held], ['bbbbbbbbbbbb', quoted]]));
    expect(text).to.include(
      '↳ applied before analysis: candidates suppressed until 2026-09-25 (alpha-example-org/suppressed.json)',
    );
    expect(text).to.include('↳ in today\'s analysis prompt for gamma.example.org (gamma-example-org/prompt.pass1.md, '
      + '4 of 17 lines quoted) · <https://langfuse.example.org/trace/t1?observation=obs1|trace>');
    // The quoted lines follow, as a block quote, with people masked and mrkdwn escaped (FR-062).
    expect(text).to.include('\n> "kind": "note",\n> "verdict": "up",\n> "note": "#2 👍 [person]",\n> "horizon": null,');
    expect(text).to.not.include('U0123ABCD');
    expect(digest.items.find((i) => i.item_id === 'bbbbbbbbbbbb').provenance).to.deep.equal(quoted);
    expect(digest.items.find((i) => i.item_id === 'aaaaaaaaaaaa').provenance).to.deep.equal(held);
    const first = blocks[0].text.text;
    expect(first).to.include('> "verdict": "up",');
    expect(first).to.include('suppressed until 2026-09-25 (alpha-example-org/suppressed.json)');
    expect(first).to.not.include('U0123ABCD');
  });

  it('says when the feedback was not used, caps the quote at eight lines, and lists a shared proposal once', () => {
    const many = {
      ...quoted, lines: Array.from({ length: 12 }, (_, i) => `"note": "line ${i}",`), lines_total: 60,
      trace_url: 'https://langfuse.example.org/trace/t1',
    };
    const review = {
      classified: [
        {
          feedback_id: 'f2f2f2f2f2f2', classification: 'prompt', proposal_id: '2026-09-19-prompt-window-first',
          proposal_path: '/data/proposals/p.md',
        },
        {
          feedback_id: 'f3f3f3f3f3f3', classification: 'prompt', proposal_id: '2026-09-19-prompt-window-first',
          proposal_path: '/data/proposals/p.md',
        },
      ],
      unclassified: [],
    };
    const { digest, text } = build(new Map([['bbbbbbbbbbbb', many]]), { review, suppressed: [] });
    expect(text).to.include('↳ not used today: alpha.example.org was not analysed and nothing was suppressed');
    expect(text).to.include('8 of 60 lines quoted');
    expect(text.match(/^> /gm)).to.have.length(9);
    expect(text).to.include('> … 4 more of these lines in gamma-example-org/prompt.pass1.md');
    expect(text).to.not.include('line 8');
    expect(digest.proposals).to.deep.equal([
      { proposal_id: '2026-09-19-prompt-window-first', type: 'prompt', path: '/data/proposals/p.md' },
    ]);
    expect(text.split('/data/proposals/p.md')).to.have.length(2);
    expect(digest.items.find((i) => i.item_id === 'aaaaaaaaaaaa').provenance).to.deep.equal({
      applied: 'none', prompt_path: null, records: 0, lines: [], lines_total: 0, trace_url: null,
      suppressed_until: null, suppressed_path: null,
    });
  });

  it('writes no provenance line when none was computed, so older callers read as before', () => {
    const { digest, text } = build(undefined);
    expect(text).to.not.include('↳');
    expect(digest.items.every((i) => i.provenance === undefined)).to.equal(true);
  });
});

describe('publish/digest: alert-group feedback (User Story 8)', () => {
  it('acknowledges reactions and notes on alert groups in their own lines, naming no person', () => {
    const records = [
      record({
        feedback_id: 'a1a1a1a1a1a1', target: 'alert_group', item_id: null, alert_key: 'North Programme/backlog',
        verdict: 'down',
      }),
      record({
        feedback_id: 'a2a2a2a2a2a2', target: 'alert_group', item_id: null, alert_key: 'North Programme/backlog',
        verdict: 'down', author: 'U8', source_ts: '2.2',
      }),
      record({
        feedback_id: 'a3a3a3a3a3a3', target: 'alert_group', item_id: null, alert_key: 'North Programme/backlog',
        kind: 'note',
        verdict: null, note: 'known migration <@U0123ABCD>', source_ts: '2.3',
      }),
      record({
        feedback_id: 'a4a4a4a4a4a4', target: 'alert_group', item_id: null, alert_key: 'South Programme/messaging',
        verdict: 'up', source_ts: '2.4',
      }),
    ];
    const built = buildDigest({
      runId: '2026-09-19', date: '2026-09-19', records, byItem: {}, items: [], retention: RETENTION,
    });
    expect(built.digest.alerts).to.deep.equal([
      { alert_key: 'North Programme/backlog', up: 0, down: 2, notes: 1 },
      { alert_key: 'South Programme/messaging', up: 1, down: 0, notes: 0 },
    ]);
    expect(built.digest.items).to.deep.equal([]);
    expect(built.text).to.include('North Programme/backlog: 2 thumbs-down, 1 note');
    expect(built.text).to.include('South Programme/messaging: 1 thumbs-up');
    expect(built.text).to.not.include('U0123ABCD');
    expect(built.digest.acknowledged).to.have.length(4);
    expect(built.metadata.event_payload.acknowledged).to.equal(4);
  });
});
