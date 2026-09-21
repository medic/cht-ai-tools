const fs = require('node:fs');
const path = require('node:path');
const { buildPayload } = require('../../src/publish/payload');
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
    expect(payload.image, 'the brief image was retired in revision 24').to.equal(null);
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

  it('carries no image and no image block even when a stored brief still names one (revision 24)', () => {
    const stale = makeBrief({ image: { path: 'rollup/brief.png', slack_file_id: 'F123' } });
    const payload = buildPayload({ ...args, brief: stale, items: [item] });
    expect(payload.image).to.equal(null);
    expect(payload.parent.blocks.some((b) => b.type === 'image')).to.equal(false);
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

  it('lists at most fifty instances, fewer when the block cannot hold them, and says how many more there are', () => {
    const payload = buildPayload({ ...args, alertGroups: [many], alertLinks: new Map() });
    const reply = payload.replies[1];
    expect(MAX_ALERT_INSTANCES).to.equal(50);
    const shown = (reply.text.match(/DB Fragmentation on/g) || []).length;
    expect(shown).to.be.at.most(50).and.at.least(20);
    expect(reply.text).to.include(`and ${60 - shown} more`);
    expect(reply.text.length).to.be.at.most(3000);
    expect(reply.text).to.equal(reply.blocks[0].text.text);
  });

  it('fits an alert reply into one section without cutting a link: fewer hosts named, then shorter links', () => {
    const hosts = Array.from({ length: 43 }, (_, i) => `county-${String(i).padStart(2, '0')}.south.example.org`);
    const instances = hosts.map((h) => classified('delivery', h, { started_at: '2026-09-18T00:00:00Z' }));
    const wide = alertGroupOf(instances, {
      patterns: [{
        title: 'Message Delivery Rate', count: 43, of: 47, since_min: '2026-09-18', since_max: '2026-09-20', hosts,
        instance_ids: instances.map((i) => i.instance_id),
      }],
    });
    const filteredFor = (list, extra) => 'https://watchdog.example.org/alerting/list?search='
      + encodeURIComponent(`namespace:CHT state:firing ${extra}label:instance=~"^(${list.join('|')})$"`);
    const filtered = (extra) => filteredFor(hosts, extra);
    const shortRule = 'https://watchdog.example.org/alerting/list?search=rule';
    const linksFor = (list) => ({
      group: filteredFor(list, ''),
      rules: [{ title: 'Message Delivery Rate', url: filteredFor(list, 'rule:"Message Delivery Rate" ') }],
      short: {
        group: 'https://watchdog.example.org/alerting/list?search=all',
        rules: [{ title: 'Message Delivery Rate', url: shortRule }],
      },
      all: [],
    });
    const links = linksFor(hosts);
    const wellFormed = (text) => {
      expect(text.length).to.be.at.most(3000);
      expect(text).to.not.include('…<');
      expect(text).to.not.match(/…$/);
      const linksInText = [...text.matchAll(/<(https?:[^|>]+)\|([^>]*)>/g)];
      expect(linksInText.length).to.be.at.least(1);
      for (const [, url] of linksInText) {
        expect(url).to.match(/^https:\/\/watchdog\.example\.org\/alerting\/list\?search=/);
      }
      return linksInText;
    };
    // Forty-three hosts: both filtered links do not fit, so the per-rule filtered link goes and the filtered group
    // link is kept with every host still named; the short links are not needed yet.
    const payload = buildPayload({ ...args, alertGroups: [wide], alertLinks: new Map([[wide.alert_key, links]]) });
    const reply = payload.replies[1];
    const text = reply.blocks[0].text.text;
    expect(reply.text).to.equal(text);
    wellFormed(text);
    expect(text).to.include(filtered(''));
    expect(text).to.not.include(filtered('rule:"Message Delivery Rate" '));
    expect(text).to.not.include(shortRule);
    expect(text).to.include('county-00.south.example.org').and.include('county-42.south.example.org');
    expect(text).to.not.match(/\+\d+ more/);
    expect(text).to.include('Programme-wide: Message Delivery Rate on 43 of 47 projects');
    // Many more hosts: even the group link filtered by host is too long, so the links without the host filter are
    // used, the host list stays elided with its count, and no link is cut.
    const crowd = Array.from({ length: 140 }, (_, i) => `facility-${String(i).padStart(3, '0')}.south.example.org`);
    const crowdInstances = crowd.map((h) => classified('delivery', h, { started_at: '2026-09-18T00:00:00Z' }));
    const crowded = alertGroupOf(crowdInstances, {
      patterns: [{
        title: 'Message Delivery Rate', count: 140, of: 150, since_min: '2026-09-18', since_max: '2026-09-20',
        hosts: crowd, instance_ids: crowdInstances.map((i) => i.instance_id),
      }],
    });
    const crowdedPayload = buildPayload({
      ...args, alertGroups: [crowded], alertLinks: new Map([[crowded.alert_key, linksFor(crowd)]]),
    });
    const crowdedText = crowdedPayload.replies[1].blocks[0].text.text;
    wellFormed(crowdedText);
    expect(crowdedText).to.include(shortRule);
    expect(crowdedText).to.not.include('label%3Ainstance');
    expect(crowdedText).to.match(/facility-000\.south\.example\.org.*, \+128 more/);
    expect(crowdedText).to.not.include('facility-139');
    // A group that fits keeps every host and the filtered links.
    const small = buildPayload(args);
    expect(small.replies[1].text).to.include('https://watchdog.example.org/alerting/list?search=rule');
  });

  it('keeps the alerts bullet in the parent text and blocks as an indented section', () => {
    const payload = buildPayload(args);
    const sections = payload.parent.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
    expect(sections[0])
      .to.include('North Programme alerts: 2 firing, 1 stale for more than 14 days\n   ◦ backlog: 2 firing');
  });
});

describe('publish/payload: replies for body items only, the report in the thread, related items (revision 23)', () => {
  const { MAX_ITEM_REPLIES } = require('../../src/publish/payload');
  const body = makeItem({ rank: 1, placement: 'body' });
  const threadItem = makeItem({ metric: 'cht_conflict_count', severity: 'low', rank: 2, placement: 'thread' });
  const related = makeItem({
    metric: 'cht_outbound_push_backlog_count', severity: 'medium', rank: 3, placement: 'thread',
    relates_to: { item_id: body.item_id, metric: body.metric, relation: 'same_cause' },
  });
  const report = { path: 'rollup/report.html', slack_file_id: null, ts: null };
  const brief = makeBrief({ bullets: [{ item_id: body.item_id, text: 'alpha 912 vs 300' }], report });
  const layout = { body_items: [body.item_id], thread_items: [threadItem.item_id, related.item_id] };
  const args = () => ({
    brief, items: [body, threadItem, related], links: new Map(), runId: '2026-09-18', date: '2026-09-18',
    audience: 'internal', channel: 'C123', layout,
  });

  it('builds a reply for each body item of the layout, in rank order, and none for a thread item', () => {
    const payload = buildPayload(args());
    expect(payload.replies.map((r) => r.item_id)).to.deep.equal([body.item_id]);
  });

  it('falls back to the items\' placement when no layout is given', () => {
    const withoutLayout = { ...args() };
    delete withoutLayout.layout;
    expect(buildPayload(withoutLayout).replies.map((r) => r.item_id)).to.deep.equal([body.item_id]);
  });

  it('caps the item replies at twenty-five, a constant in code', () => {
    expect(MAX_ITEM_REPLIES).to.equal(25);
    const many = Array.from({ length: 30 }, (_, i) => makeItem({
      project_url: `https://p${i}.example.org`, rank: i + 1, placement: 'body',
    }));
    const wide = makeBrief({ bullets: [{ item_id: many[0].item_id, text: 'p0 912 vs 300' }], report });
    const payload = buildPayload({
      ...args(), brief: wide, items: many, layout: { body_items: many.map((i) => i.item_id), thread_items: [] },
    });
    expect(payload.replies.filter((r) => r.item_id)).to.have.length(25);
    expect(payload.replies[24].item_id).to.equal(many[24].item_id);
  });

  it('carries the report as a share into the thread with a code-built comment that says how to cite an item', () => {
    const payload = buildPayload(args());
    expect(payload.report).to.include({
      filename: 'report-2026-09-18.html', path: 'rollup/report.html', items: 3, replied: 1, slack_file_id: null,
      ts: null,
    });
    expect(payload.report.title).to.include('2026-09-18');
    expect(payload.report.initial_comment).to.include('3 items').and.include('1 with a reply');
    expect(payload.report.initial_comment).to.include('#2').and.include('host and metric');
    expect(payload.report.initial_comment).to.match(/👍|:\+1:/);
  });

  it('says in the footer how many items are only in the report', () => {
    const payload = buildPayload(args());
    const footer = payload.parent.blocks[payload.parent.blocks.length - 1].elements[0].text;
    expect(footer).to.include('2 more items in the report');
    const all = buildPayload({ ...args(), items: [body], layout: { body_items: [body.item_id], thread_items: [] } });
    const footerAll = all.parent.blocks[all.parent.blocks.length - 1].elements[0].text;
    expect(footerAll).to.not.include('more items');
  });

  it('carries no report when the brief has none, nor on a heartbeat or a failure', () => {
    const none = buildPayload({ ...args(), brief: makeBrief({ bullets: [{ item_id: body.item_id, text: 'x' }] }) });
    expect(none.report).to.equal(null);
    const heartbeat = buildPayload({
      ...args(), brief: makeBrief({ kind: 'heartbeat', headline: 'All quiet', bullets: [], report }), items: [],
    });
    expect(heartbeat.report).to.equal(null);
  });

  it('names the lower-ranked items that relate to a body item in that item\'s reply, with relation and rank', () => {
    const payload = buildPayload(args());
    expect(payload.replies[0].text).to.include('Related: `cht_outbound_push_backlog_count` (same cause) #3');
    const unrelated = buildPayload({ ...args(), items: [body, threadItem] });
    expect(unrelated.replies[0].text).to.not.include('Related:');
  });
});
