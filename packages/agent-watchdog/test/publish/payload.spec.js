const fs = require('node:fs');
const path = require('node:path');
const { buildPayload, withImageBlock } = require('../../src/publish/payload');
const { AUDIENCES, assertAudience } = require('../../src/publish/audience');
const { makeItem, makeBrief } = require('../rollup/factories');

const SLACK_TEMPLATES = path.join(__dirname, '..', '..', 'templates', 'slack');

describe('publish/audience', () => {
  it('knows the audiences and only accepts internal in this feature', () => {
    expect(AUDIENCES).to.include.members(['internal', 'partner']);
    expect(() => assertAudience('internal')).to.not.throw();
    expect(() => assertAudience('partner')).to.throw(/partner/);
    expect(() => assertAudience(undefined)).to.throw();
  });
});

describe('publish/payload', () => {
  const item = makeItem({ rank: 1, placement: 'body', why_now: 'Backlog <3x & rising>' });
  const second = makeItem({
    metric: 'cht_conflict_count', severity: 'low', rank: 2, placement: 'body', confidence: 0.4,
  });
  const brief = makeBrief({
    bullets: [
      { item_id: item.item_id, text: 'alpha sentinel backlog 912 vs 300 & climbing' },
      { item_id: second.item_id, text: 'conflicts up' },
    ],
    expected_load_notice: 'Month-end window active',
  });
  const links = new Map([[item.item_id, 'https://watchdog.example.org/d/oa2OfL-Vk/cht-admin-overview?orgId=1&var-cht_instance=alpha.example.org']]);
  const args = {
    brief, items: [item, second], links, runId: '2026-09-18', date: '2026-09-18', audience: 'internal', channel: 'C123',
  };

  it('builds the parent message with header, bullet sections, notices, footer and registered metadata', () => {
    const payload = buildPayload(args);
    expect(payload.run_id).to.equal('2026-09-18');
    expect(payload.kind).to.equal('brief');
    expect(payload.parent.channel).to.equal('C123');
    const types = payload.parent.blocks.map((b) => b.type);
    expect(types[0]).to.equal('header');
    expect(types.filter((t) => t === 'section')).to.have.length(2);
    expect(types).to.not.include('image');
    expect(types.filter((t) => t === 'context')).to.have.length(2);
    expect(payload.parent.blocks[1].text.text).to.include('912 vs 300 &amp; climbing');
    const footer = payload.parent.blocks[payload.parent.blocks.length - 1].elements[0].text;
    expect(footer).to.include('<https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/prompts|prompts>');
    expect(footer).to.include('cost $0.12');
    expect(payload.parent.text).to.include('Sentinel backlog tripled on alpha');
    expect(payload.parent.text.length).to.be.at.most(4000);
    expect(payload.parent.metadata).to.deep.equal({
      event_type: 'agent_watchdog.brief',
      event_payload: { run_id: '2026-09-18', date: '2026-09-18', kind: 'brief' },
    });
    expect(payload.parent.unfurl_links).to.equal(false);
    expect(payload.image).to.deep.equal({
      filename: 'brief-2026-09-18.png', alt_text: 'Sentinel backlog tripled on alpha', path: null, slack_file_id: null,
    });
  });

  it('adds one threaded reply per item in rank order with escaped text, the dashboard link and item metadata', () => {
    const payload = buildPayload(args);
    expect(payload.replies).to.have.length(2);
    expect(payload.replies[0].item_id).to.equal(item.item_id);
    expect(payload.replies[0].text).to.include('Backlog &lt;3x &amp; rising&gt;');
    expect(payload.replies[0].text).to.include('|dashboard>');
    expect(payload.replies[1].text).to.not.include('|dashboard>');
    expect(payload.replies[0].metadata).to.deep.equal({
      event_type: 'agent_watchdog.item',
      event_payload: {
        run_id: '2026-09-18', item_id: item.item_id, project_url: item.project_url, metric: item.metric,
      },
    });
    expect(payload.replies[0].blocks[0].type).to.equal('section');
  });

  it('truncates a long header and the fallback text within Slack limits', () => {
    const longBrief = makeBrief({
      headline: 'x'.repeat(400),
      bullets: [{ item_id: item.item_id, text: 'y'.repeat(3900) }],
    });
    const payload = buildPayload({ ...args, brief: longBrief, items: [item] });
    expect(payload.parent.blocks[0].text.text.length).to.be.at.most(150);
    expect(payload.parent.text.length).to.be.at.most(4000);
  });

  it('includes the image block only once a Slack file id exists', () => {
    const withFile = makeBrief({ image: { path: 'rollup/brief.png', slack_file_id: 'F123' } });
    const payload = buildPayload({ ...args, brief: withFile, items: [item] });
    const image = payload.parent.blocks.find((b) => b.type === 'image');
    expect(image).to.deep.equal({ type: 'image', slack_file: { id: 'F123' }, alt_text: withFile.headline });
    const later = withImageBlock(buildPayload(args), 'F999');
    expect(later.parent.blocks.find((b) => b.type === 'image').slack_file.id).to.equal('F999');
    expect(later.image.slack_file_id).to.equal('F999');
    const idx = later.parent.blocks.findIndex((b) => b.type === 'image');
    expect(later.parent.blocks[idx - 1].type).to.equal('section');
  });

  it('produces text-only heartbeat and failure payloads with metadata and no replies', () => {
    const quiet = makeBrief({
      kind: 'heartbeat', headline: 'All quiet: 3 projects and 3 panels checked, no candidates', bullets: [],
    });
    const heartbeat = buildPayload({ ...args, brief: quiet, items: [] });
    expect(heartbeat.parent.blocks).to.equal(undefined);
    expect(heartbeat.parent.text).to.include('All quiet');
    expect(heartbeat.parent.text, 'the heartbeat headline carries its marker (FR-082)').to.include('✅ All quiet');
    expect(heartbeat.parent.metadata.event_payload.kind).to.equal('heartbeat');
    expect(heartbeat.replies).to.deep.equal([]);
    expect(heartbeat.image).to.equal(null);
    const failed = makeBrief({ kind: 'failure', headline: 'Run failed: metrics source unreachable', bullets: [] });
    const failure = buildPayload({ ...args, brief: failed, items: [] });
    expect(failure.parent.text).to.include('Run failed');
    expect(failure.parent.text).to.include('|trace>');
    expect(failure.replies).to.deep.equal([]);
  });

  it('rejects any audience other than internal', () => {
    expect(() => buildPayload({ ...args, audience: 'partner' })).to.throw(/partner/);
  });

  it('routes every Slack template substitution through the mrkdwn helper', () => {
    for (const file of fs.readdirSync(SLACK_TEMPLATES)) {
      const text = fs.readFileSync(path.join(SLACK_TEMPLATES, file), 'utf8');
      const substitutions = [...text.matchAll(/\{\{([^#/!][^}]*)\}\}/g)].map((m) => m[1].trim());
      const allowed = (v) => v.startsWith('mrkdwn ') || v.startsWith('else') || v.startsWith('link ');
      const raw = substitutions.filter((v) => !allowed(v));
      expect(raw, `${file}: ${raw.join(', ')}`).to.deep.equal([]);
      expect(text).to.not.include('{{{');
    }
  });
});

describe('publish/payload: feedback digest (FR-062)', () => {
  const { buildPayload } = require('../../src/publish/payload');
  const { makeBrief, makeItem } = require('../rollup/factories');

  const base = () => ({
    brief: makeBrief({ kind: 'brief', bullets: [] }),
    items: [makeItem()],
    links: new Map(),
    runId: '2026-09-19',
    date: '2026-09-19',
    audience: 'internal',
  });
  const built = {
    digest: { run_id: '2026-09-19', acknowledged: ['f1f1f1f1f1f1', 'f2f2f2f2f2f2'] },
    text: 'Feedback from yesterday: 2 reactions, 0 notes',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Feedback from yesterday: 2 reactions, 0 notes' } }],
    metadata: {
      event_type: 'agent_watchdog.feedback_digest',
      event_payload: { run_id: '2026-09-19', date: '2026-09-19', acknowledged: 2 },
    },
  };

  it('carries the digest on the payload with its acknowledged ids and no reactions yet', () => {
    const payload = buildPayload({ ...base(), digest: built });
    expect(payload.digest).to.deep.equal({
      text: built.text, blocks: built.blocks, metadata: built.metadata,
      acknowledged: ['f1f1f1f1f1f1', 'f2f2f2f2f2f2'], reactions: [],
    });
    expect(payload.replies).to.have.length(1);
    expect(payload.replies.some((r) => r.kind === 'unmatched_notes')).to.equal(false);
  });

  it('sets digest to null when there is nothing to acknowledge, on briefs and heartbeats alike', () => {
    expect(buildPayload(base()).digest).to.equal(null);
    const heartbeat = buildPayload({ ...base(), brief: makeBrief({ kind: 'heartbeat', bullets: [] }) });
    expect(heartbeat.digest).to.equal(null);
    expect(heartbeat.replies).to.deep.equal([]);
  });

  it('no longer builds a separate unmatched-notes reply', () => {
    expect(() => buildPayload({ ...base(), unmatchedNotes: [{ note: 'x' }] })).to.not.throw();
    expect(buildPayload({ ...base(), unmatchedNotes: [{ note: 'x' }] }).replies).to.have.length(1);
  });
});

describe('publish/payload: sub-bullets (FR-010, FR-015, User Story 9)', () => {
  const northA = makeItem({ project_url: 'https://north-a.example.org', rank: 1, placement: 'body', slot: 1 });
  const northB = makeItem({ project_url: 'https://north-b.example.org', rank: 3, placement: 'body', slot: 1 });
  const alpha = makeItem({ rank: 2, placement: 'body', slot: 2 });
  const brief = makeBrief({
    bullets: [
      {
        kind: 'group', item_id: null, group: 'North Programme', text: 'North Programme: 2 projects with issues',
        alert_key: null,
        children: [
          { item_id: northA.item_id, text: 'north-a sentinel backlog 912 vs 300 & climbing' },
          { item_id: northB.item_id, text: 'north-b sentinel backlog 912 vs 300' },
        ],
      },
      {
        kind: 'item', item_id: alpha.item_id, group: 'Other', text: 'alpha sentinel backlog 912 vs 300', children: [],
        alert_key: null,
      },
    ],
  });
  const args = {
    brief, items: [northA, alpha, northB], links: new Map(), runId: '2026-09-18', date: '2026-09-18',
    audience: 'internal', channel: 'C123',
  };

  it('renders one section per top-level bullet with each sub-bullet on its own indented line', () => {
    const payload = buildPayload(args);
    const sections = payload.parent.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
    expect(sections).to.have.length(2);
    // The group line carries its worst child's severity marker (FR-082); sub-bullets stay plain.
    expect(sections[0].split('\n')).to.deep.equal([
      '🔴 North Programme: 2 projects with issues',
      '   ◦ north-a sentinel backlog 912 vs 300 &amp; climbing',
      '   ◦ north-b sentinel backlog 912 vs 300',
    ]);
    expect(sections[1]).to.equal('🔴 alpha sentinel backlog 912 vs 300');
    expect(payload.parent.text)
      .to.include('• 🔴 North Programme: 2 projects with issues\n   ◦ north-a sentinel backlog');
    expect(payload.parent.text).to.include('&amp; climbing');
    // Every project item still has its own thread reply, in rank order.
    expect(payload.replies.map((r) => r.item_id)).to.deep.equal([northA.item_id, alpha.item_id, northB.item_id]);
  });
});

describe('publish/payload: alert-group replies (FR-066, User Story 8)', () => {
  const { classified, groupOf: alertGroupOf } = require('../helpers/alerts');
  const { ALERTS_EVENT, MAX_ALERT_INSTANCES } = require('../../src/publish/payload');
  const northBacklog = alertGroupOf([
    classified('sentinel', 'north-a.example.org', { new: true }),
    classified('sentinel', 'north-b.example.org', { started_at: '2026-08-20T00:00:00Z' }),
  ]);
  const many = alertGroupOf(Array.from({ length: 60 }, (_, i) => classified('fragmentation', `h${i}.example.org`)));
  const item = makeItem({ rank: 1, placement: 'body', slot: 2 });
  const brief = makeBrief({
    bullets: [
      {
        kind: 'alerts', item_id: null, group: 'North Programme', alert_key: 'North Programme',
        text: 'North Programme alerts: 2 firing, 1 stale for more than 14 days',
        children: [
          { item_id: null, text: 'backlog: 2 firing (Sentinel Backlog), oldest since 2026-08-20, 1 stale, 1 new' },
        ],
      },
      {
        kind: 'item', item_id: item.item_id, group: 'Other', text: 'alpha sentinel backlog 912 vs 300', children: [],
        alert_key: null,
      },
    ],
  });
  const alertLinks = new Map([
    ['North Programme/backlog', {
      group: 'https://watchdog.example.org/alerting/list?search=group',
      rules: [{ title: 'Sentinel Backlog', url: 'https://watchdog.example.org/alerting/list?search=rule' }],
      all: ['https://watchdog.example.org/alerting/list?search=group', 'https://watchdog.example.org/alerting/list?search=rule'],
    }],
  ]);
  const args = {
    brief, items: [item], links: new Map(), runId: '2026-09-18', date: '2026-09-18', audience: 'internal',
    channel: 'C123', alertGroups: [northBacklog], alertLinks, staleAfterDays: 14,
  };

  it('marks the headline, bullets and notices with code-placed emoji (FR-082)', () => {
    const noticed = {
      ...brief, notices: ['Resolved since the previous run: Sentinel Backlog on north-b.example.org (fired 3d)'],
    };
    const payload = buildPayload({ ...args, brief: noticed });
    expect(payload.parent.blocks[0].text.text).to.match(/^🚨 |^📋 /);
    const sections = payload.parent.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
    expect(sections[0].startsWith('🚨 North Programme alerts: 2 firing')).to.equal(true);
    expect(sections[1].startsWith(`🔴 alpha sentinel backlog 912 vs 300`)).to.equal(true);
    const contexts = payload.parent.blocks.filter((b) => b.type === 'context').map((b) => b.elements[0].text);
    expect(contexts.some((t) => t.startsWith('_✅ Resolved since the previous run'))).to.equal(true);
    expect(payload.parent.text).to.include('🚨 North Programme alerts');
    expect(payload.parent.text).to.include('_✅ Resolved since the previous run');
    expect(payload.image.alt_text, 'alt text carries no marker').to.equal(brief.headline);
  });

  it('collapses a pattern into one paragraph and shows the metric next to an alert (FR-078, FR-079)', () => {
    const wideInstances = Array.from({ length: 4 }, (_, i) => classified('delivery', `south-${i}.example.org`, {
      started_at: `2026-09-1${6 + (i % 3)}T00:00:00Z`,
      evidence: i === 0 ? {
        metric: 'cht_messaging_outgoing_total{status="delivered"}', aggregate: 'level', current_value: 12000,
        previous_day_value: 12400, pct_change_vs_previous_day: -3.2,
      } : null,
    }));
    const single = classified('outbound', 'south-9.example.org', {
      evidence: { metric: 'cht_outbound_push_backlog_count', aggregate: 'level', current_value: 247909,
        previous_day_value: 263364, pct_change_vs_previous_day: -5.9 },
    });
    const pattern = {
      title: 'Message Delivery Rate', count: 4, of: 5, since_min: '2026-09-16', since_max: '2026-09-18',
      hosts: wideInstances.map((i) => i.host).sort(), instance_ids: wideInstances.map((i) => i.instance_id),
    };
    const group = alertGroupOf([...wideInstances, single], { patterns: [pattern] });
    const payload = buildPayload({ ...args, alertGroups: [group], alertLinks: new Map() });
    const reply = payload.replies.find((r) => r.alert_key === group.alert_key);
    expect(reply.text)
      .to.include('🔁 Programme-wide: Message Delivery Rate on 4 of 5 projects, first 2026-09-16, last 2026-09-18');
    expect(reply.text).to.include('south-0.example.org, south-1.example.org, south-2.example.org, south-3.example.org');
    expect(reply.text.match(/• Message Delivery Rate on/g), 'pattern members are not listed one by one').to.equal(null);
    expect(reply.text).to.include('• Outbound Push Backlog on south-9.example.org');
    expect(reply.text).to.include('cht_outbound_push_backlog_count 247,909 now (yesterday 263,364)');
  });

  it('adds the firing alert to an item reply when the alert category covers the item metric (FR-079)', () => {
    const backlogAlert = classified('sentinel', 'alpha.example.org', { started_at: '2026-09-16T06:00:00Z' });
    const group = alertGroupOf([backlogAlert]);
    const payload = buildPayload({
      ...args, alertGroups: [group], alertLinks: new Map(),
      alertCategories: { backlog: ['cht_sentinel_backlog_count', 'cht_outbound_push_backlog_count'] },
    });
    const reply = payload.replies.find((r) => r.item_id === item.item_id);
    expect(reply.text).to.include('🚨 Alert firing: Sentinel Backlog since 2026-09-16 (2d)');
    const without = buildPayload({ ...args, alertGroups: [group], alertLinks: new Map(), alertCategories: {} });
    expect(without.replies.find((r) => r.item_id === item.item_id).text).to.not.include('Alert firing');
  });

  it('adds one reply per alert group after the item replies, with the instances, links and registered metadata', () => {
    const payload = buildPayload(args);
    expect(payload.replies).to.have.length(2);
    expect(payload.replies[0].item_id).to.equal(item.item_id);
    const reply = payload.replies[1];
    expect(reply).to.include({ alert_key: 'North Programme/backlog', item_id: null });
    expect(reply.text).to.include('North Programme');
    expect(reply.text).to.include('backlog');
    expect(reply.text).to.match(/Sentinel Backlog on north-b\.example\.org .*stale/);
    expect(reply.text).to.include('<https://watchdog.example.org/alerting/list?search=group|');
    expect(reply.text).to.include('<https://watchdog.example.org/alerting/list?search=rule|Sentinel Backlog>');
    expect(reply.metadata).to.deep.equal({
      event_type: ALERTS_EVENT,
      event_payload: {
        run_id: '2026-09-18', date: '2026-09-18', group: 'North Programme', category: 'backlog', firing: 2,
      },
    });
    expect(ALERTS_EVENT).to.equal('agent_watchdog.alerts');
    expect(reply.blocks[0].type).to.equal('section');
  });

  it('lists at most fifty instances and says how many more there are', () => {
    const payload = buildPayload({ ...args, alertGroups: [many], alertLinks: new Map() });
    const reply = payload.replies[1];
    expect(MAX_ALERT_INSTANCES).to.equal(50);
    expect(reply.text.match(/DB Fragmentation on/g)).to.have.length(50);
    expect(reply.text).to.include('and 10 more');
    expect(reply.text.length).to.be.at.most(4000);
  });

  it('keeps the alerts bullet in the parent text and blocks as an indented section', () => {
    const payload = buildPayload(args);
    const sections = payload.parent.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
    expect(sections[0])
      .to.include('North Programme alerts: 2 firing, 1 stale for more than 14 days\n   ◦ backlog: 2 firing');
  });
});
