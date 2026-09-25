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

  it('builds the parent message with the headline, bullet sections, notices, footer and registered metadata', () => {
    const payload = buildPayload(args);
    expect(payload.run_id).to.equal('2026-09-18');
    expect(payload.kind).to.equal('brief');
    expect(payload.parent.channel).to.equal('C123');
    const types = payload.parent.blocks.map((b) => b.type);
    // The headline is a bold section shown whole, never Slack's header block (FR-019, revision 28).
    expect(types[0]).to.equal('section');
    expect(payload.parent.blocks[0].text.text).to.match(/^\*📋 Sentinel backlog tripled on alpha/);
    expect(payload.parent.blocks[0].text.text.endsWith('*')).to.equal(true);
    expect(types.filter((t) => t === 'section')).to.have.length(3);
    expect(types).to.not.include('image');
    expect(types.filter((t) => t === 'context')).to.have.length(2);
    expect(payload.parent.blocks[1].text.text).to.include('912 vs 300 &amp; climbing');
    const footer = payload.parent.blocks[payload.parent.blocks.length - 1].elements[0].text;
    expect(footer).to.include('<https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/specs/001-watchdog-slack-loop|specs>');
    expect(footer).to.include('run 2026-09-18');
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

  it('adds no item replies; a thread bullet becomes a programme or Other reply with escaped text and metadata', () => {
    // No reply per item since revision 28: the body covers the projects and the report is shared into the thread.
    expect(buildPayload(args).replies).to.deep.equal([]);
    const other = {
      kind: 'group', item_id: null, item_ids: [], group: 'Other', alert_key: null, text: 'Other: 1 project with issues',
      children: [{ item_id: second.item_id, item_ids: [second.item_id], text: 'conflicts up & rising' }],
    };
    const withThread = buildPayload({ ...args, brief: { ...brief, thread: [other] } });
    expect(withThread.replies).to.have.length(1);
    const [reply] = withThread.replies;
    expect(reply).to.include({ kind: 'other', group: 'Other', item_id: null, alert_key: null });
    // The group line carries its worst child's severity marker (FR-082); the project lines follow as bullets.
    expect(reply.text).to.equal('🟡 Other: 1 project with issues\n• conflicts up &amp; rising');
    expect(reply.blocks).to.deep.equal([{ type: 'section', text: { type: 'mrkdwn', text: reply.text } }]);
    expect(reply.metadata).to.deep.equal({
      event_type: 'agent_watchdog.programme',
      event_payload: {
        run_id: '2026-09-18', date: '2026-09-18', group: 'Other', kind: 'other', item_ids: [second.item_id],
      },
    });
    const programme = { ...other, group: 'North Programme', text: 'North Programme: 1 project with issues' };
    const both = buildPayload({ ...args, brief: { ...brief, thread: [programme, other] } });
    expect(both.replies.map((r) => r.kind)).to.deep.equal(['programme', 'other']);
    expect(both.replies[0].metadata.event_payload).to.include({ group: 'North Programme', kind: 'programme' });
  });

  it('shows a long headline whole in its bold section and keeps the fallback text within Slack limits', () => {
    const longBrief = makeBrief({
      headline: 'x'.repeat(400),
      bullets: [{ item_id: item.item_id, text: 'y'.repeat(3900) }],
    });
    const payload = buildPayload({ ...args, brief: longBrief, items: [item] });
    expect(payload.parent.blocks[0].type).to.equal('section');
    expect(payload.parent.blocks[0].text.text).to.include('x'.repeat(400));
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
    expect(payload.replies).to.deep.equal([]);
  });

  it('sets digest to null when there is nothing to acknowledge, on briefs and heartbeats alike', () => {
    expect(buildPayload(base()).digest).to.equal(null);
    const heartbeat = buildPayload({ ...base(), brief: makeBrief({ kind: 'heartbeat', bullets: [] }) });
    expect(heartbeat.digest).to.equal(null);
    expect(heartbeat.replies).to.deep.equal([]);
  });

  it('no longer builds a separate unmatched-notes reply', () => {
    expect(() => buildPayload({ ...base(), unmatchedNotes: [{ note: 'x' }] })).to.not.throw();
    expect(buildPayload({ ...base(), unmatchedNotes: [{ note: 'x' }] }).replies).to.deep.equal([]);
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
    // The headline section, then one section per bullet (revision 28).
    expect(sections).to.have.length(3);
    // The group line carries its worst child's severity marker (FR-082); sub-bullets stay plain.
    expect(sections[1].split('\n')).to.deep.equal([
      '🔴 North Programme: 2 projects with issues',
      '   ◦ north-a sentinel backlog 912 vs 300 &amp; climbing',
      '   ◦ north-b sentinel backlog 912 vs 300',
    ]);
    expect(sections[2]).to.equal('🔴 alpha sentinel backlog 912 vs 300');
    expect(payload.parent.text)
      .to.include('• 🔴 North Programme: 2 projects with issues\n   ◦ north-a sentinel backlog');
    expect(payload.parent.text).to.include('&amp; climbing');
    // No reply per project: every item is in the body or the report (revision 28).
    expect(payload.replies).to.deep.equal([]);
    const footer = payload.parent.blocks[payload.parent.blocks.length - 1].elements[0].text;
    expect(footer).to.not.include('more item');
  });
});

describe('publish/payload: the alerts reply (FR-066, FR-080, User Story 8, revision 28)', () => {
  const { classified, groupOf: alertGroupOf } = require('../helpers/alerts');
  const { ALERTS_EVENT, alertsSummary, alertsReplyFor } = require('../../src/publish/payload');
  const northBacklog = alertGroupOf([
    classified('sentinel', 'north-a.example.org', { new: true }),
    classified('sentinel', 'north-b.example.org', { started_at: '2026-08-20T00:00:00Z' }),
  ]);
  const northAvailability = alertGroupOf([classified('apiDown', 'north-b.example.org')]);
  const southDelivery = alertGroupOf([classified('delivery', 'south-a.example.org')]);
  const alertGroups = [northBacklog, northAvailability, southDelivery];
  const item = makeItem({ rank: 1, placement: 'body', slot: 1 });
  const brief = makeBrief({
    bullets: [{
      kind: 'item', item_id: item.item_id, group: 'Other', text: 'alpha sentinel backlog 912 vs 300', children: [],
      alert_key: null,
    }],
  });
  const alertsLinks = {
    byGroup: new Map([['North Programme', 'https://watchdog.example.org/alerting/list?search=north']]),
    all: 'https://watchdog.example.org/alerting/list?search=all',
  };
  const args = {
    brief, items: [item], runId: '2026-09-18', date: '2026-09-18', audience: 'internal', channel: 'C123',
    alertGroups, alertsLinks,
  };

  it('sums the firing alerts per programme, largest first, with the categories, new and stale counts', () => {
    const summary = alertsSummary(alertGroups);
    expect(summary.map((s) => [s.group, s.firing, s.new, s.stale]))
      .to.deep.equal([['North Programme', 3, 1, 1], ['South Programme', 1, 0, 0]]);
    expect(summary[0].categories).to.deep.equal([
      { category: 'backlog', firing: 2 }, { category: 'availability', firing: 1 },
    ]);
    expect(alertsSummary([])).to.deep.equal([]);
  });

  it('adds one alerts reply after the programme replies with the counts, the links and registered metadata', () => {
    const payload = buildPayload(args);
    expect(payload.replies).to.have.length(1);
    const [reply] = payload.replies;
    expect(reply).to.include({ kind: 'alerts', group: null, item_id: null, alert_key: null });
    expect(reply.text.split('\n')).to.deep.equal([
      '*ALERTS* · 4 firing across 2 programmes',
      '• North Programme: 3 firing (backlog 2, availability 1), 1 new, 1 stale · '
        + '<https://watchdog.example.org/alerting/list?search=north|alert list>',
      '• South Programme: 1 firing (messaging 1), 0 new, 0 stale',
      '<https://watchdog.example.org/alerting/list?search=all|all firing alerts>',
    ]);
    expect(reply.text, 'the instances are in the report, not the reply').to.not.include('north-a.example.org');
    expect(reply.blocks).to.deep.equal([{ type: 'section', text: { type: 'mrkdwn', text: reply.text } }]);
    expect(reply.metadata).to.deep.equal({
      event_type: ALERTS_EVENT,
      event_payload: {
        run_id: '2026-09-18', date: '2026-09-18', firing: 4, programmes: ['North Programme', 'South Programme'],
      },
    });
    expect(ALERTS_EVENT).to.equal('agent_watchdog.alerts');
    const other = {
      kind: 'group', item_id: null, item_ids: [], group: 'Other', alert_key: null, text: 'Other: 1 project with issues',
      children: [{ item_id: item.item_id, item_ids: [item.item_id], text: 'x' }],
    };
    const ordered = buildPayload({ ...args, brief: { ...brief, thread: [other] } });
    expect(ordered.replies.map((r) => r.kind)).to.deep.equal(['other', 'alerts']);
  });

  it('moves the alert-derived notices from the post body to the alerts reply, with their markers (FR-080)', () => {
    const noticed = {
      ...brief,
      notices: [
        'Resolved since the previous run: Sentinel Backlog on north-b.example.org (fired 3d)',
        'Housekeeping: 3 alerts stale for 24+ days on 1 host with no data (north-b.example.org): remove them',
        'First run for alpha.example.org',
      ],
    };
    const payload = buildPayload({ ...args, brief: noticed });
    const contexts = payload.parent.blocks.filter((b) => b.type === 'context').map((b) => b.elements[0].text);
    expect(contexts.some((text) => text.includes('Resolved since'))).to.equal(false);
    expect(contexts.some((text) => text.includes('Housekeeping'))).to.equal(false);
    expect(contexts.some((text) => text.includes('First run for alpha.example.org'))).to.equal(true);
    expect(payload.parent.text).to.not.include('Resolved since');
    expect(payload.parent.text).to.not.include('Housekeeping');
    expect(payload.parent.text).to.include('First run for alpha.example.org');
    const reply = payload.replies.find((r) => r.kind === 'alerts');
    expect(reply.text)
      .to.include('\n✅ Resolved since the previous run: Sentinel Backlog on north-b.example.org (fired 3d)');
    expect(reply.text).to.match(/\n\S+ Housekeeping: 3 alerts stale/);
    expect(reply.text).to.not.include('First run');
  });

  it('marks the headline and the bullets with code-placed emoji, the headline in bold (FR-082)', () => {
    const payload = buildPayload(args);
    expect(payload.parent.blocks[0].text.text).to.match(/^\*📋 /);
    const sections = payload.parent.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
    expect(sections).to.have.length(2);
    expect(sections[1].startsWith('🔴 alpha sentinel backlog 912 vs 300')).to.equal(true);
    expect(payload.parent.text).to.include('• 🔴 alpha sentinel backlog 912 vs 300');
  });

  it('says so in the alerts reply when alerting was unavailable, and builds none when there is nothing to say', () => {
    const unavailable = { ...brief, notices: ['Alerts unavailable: Grafana returned 503'] };
    const payload = buildPayload({
      ...args, brief: unavailable, alertGroups: [], alertsLinks: { byGroup: new Map(), all: null },
    });
    expect(payload.replies).to.have.length(1);
    expect(payload.replies[0].kind).to.equal('alerts');
    expect(payload.replies[0].text.split('\n'))
      .to.deep.equal(['*ALERTS* · none firing', '⚠️ Alerts unavailable: Grafana returned 503']);
    expect(payload.replies[0].metadata.event_payload).to.deep.equal({
      run_id: '2026-09-18', date: '2026-09-18', firing: 0, programmes: [],
    });
    expect(payload.parent.text).to.not.include('Alerts unavailable');
    expect(buildPayload({ ...args, alertGroups: [] }).replies).to.deep.equal([]);
    const nothing = alertsReplyFor({
      alertGroups: [], alertsLinks: null, notices: ['First run for alpha.example.org'], runId: 'r', date: 'd',
    });
    expect(nothing).to.equal(null);
  });

  it('stays within one section however many alerts fire, and names no instance', () => {
    const many = alertGroupOf(Array.from({ length: 60 }, (_, i) => classified('fragmentation', `h${i}.example.org`)));
    const payload = buildPayload({ ...args, alertGroups: [many] });
    const reply = payload.replies.find((r) => r.kind === 'alerts');
    expect(reply.text).to.include('*ALERTS* · 60 firing across 1 programme');
    expect(reply.text).to.include('• Other: 60 firing (database 60), 0 new, 0 stale');
    expect(reply.text).to.not.include('h1.example.org');
    expect(reply.text.length).to.be.at.most(3000);
    expect(reply.text).to.equal(reply.blocks[0].text.text);
  });
});

describe('publish/payload: the alerts reply is fitted line by line, links whole (revision 34)', () => {
  const { classified, groupOf: alertGroupOf } = require('../helpers/alerts');
  const item = makeItem({ rank: 1, placement: 'body', slot: 1 });
  const brief = makeBrief({
    bullets: [{
      kind: 'item', item_id: item.item_id, group: 'Other', text: 'alpha 912 vs 300', children: [], alert_key: null,
    }],
  });
  const programmes = Array.from({ length: 60 }, (_, i) => `Programme number ${i} with a long descriptive name`);
  const alertGroups = programmes.map((group, i) => ({
    ...alertGroupOf([classified('sentinel', `host-${i}.example.org`)]), group,
  }));
  const byGroup = new Map(programmes.map((group, i) => [
    group, `https://watchdog.example.org/alerting/list?search=${encodeURIComponent(`group:"${group}" host ${i}`)}`,
  ]));
  const alertsLinks = { byGroup, all: 'https://watchdog.example.org/alerting/list?search=all' };

  it('drops whole programme lines from the end, says how many are in the report, and never cuts a link', () => {
    const payload = buildPayload({
      brief, items: [item], runId: '2026-09-18', date: '2026-09-18', audience: 'internal', channel: 'C123',
      alertGroups, alertsLinks,
    });
    const reply = payload.replies.find((r) => r.kind === 'alerts');
    expect(reply.text.length).to.be.at.most(3000);
    const opened = (reply.text.match(/</g) || []).length;
    const closed = (reply.text.match(/\|[^>]*>/g) || []).length;
    expect(opened, 'every link that starts is closed').to.equal(closed);
    expect(reply.text).to.include('*ALERTS* · 60 firing across 60 programmes');
    expect(reply.text).to.match(/\+\d+ more programmes in the report/);
    expect(reply.text).to.include('<https://watchdog.example.org/alerting/list?search=all|all firing alerts>');
    expect(reply.text).to.equal(reply.blocks[0].text.text);
    expect(reply.metadata.event_payload.programmes).to.have.length(60);
  });
});

describe('publish/payload: a programme whose filtered link is too long keeps its line (revision 36)', () => {
  const { classified, groupOf: alertGroupOf } = require('../helpers/alerts');
  const { buildAlertsLinks } = require('../../src/links/build');
  const item = makeItem({ rank: 1, placement: 'body', slot: 1 });
  const notices = [
    'Housekeeping: 2 alerts stale for 24+ days on 1 host with no data (dark.example.org): remove them',
    'Resolved since the previous run: Sentinel Backlog on quiet.example.org (fired 3d)',
  ];
  const brief = makeBrief({
    bullets: [{
      kind: 'item', item_id: item.item_id, group: 'Other', text: 'alpha 912 vs 300', children: [], alert_key: null,
    }],
    notices,
  });
  const hosts = Array.from({ length: 61 }, (_, i) => `programme-${String(i).padStart(2, '0')}.example.org`);
  const alertGroups = [{ ...alertGroupOf(hosts.map((host) => classified('sentinel', host))), group: 'Other' }];
  const alertsLinks = buildAlertsLinks({ grafanaUrl: 'https://watchdog.example.org', alertGroups });

  it('leaves the oversized link off the programme line and keeps the line, the notices and the all-alerts link', () => {
    expect(alertsLinks.byGroup.get('Other').length).to.be.greaterThan(1000);
    const payload = buildPayload({
      brief, items: [item], runId: '2026-09-18', date: '2026-09-18', audience: 'internal', channel: 'C123',
      alertGroups, alertsLinks,
    });
    const reply = payload.replies.find((r) => r.kind === 'alerts');
    expect(reply.text.length).to.be.at.most(3000);
    expect(reply.text).to.include('*ALERTS* · 61 firing across 1 programme');
    expect(reply.text).to.match(/\n• Other: 61 firing/);
    expect(reply.text).to.not.include('|alert list>');
    expect(reply.text).to.include(`<${alertsLinks.all}|all firing alerts>`);
    expect(reply.text).to.include('Housekeeping: 2 alerts stale');
    expect(reply.text).to.include('Resolved since the previous run');
    expect(reply.text).to.not.include('more programmes in the report');
    expect(reply.text).to.not.include('…');
  });

  it('keeps a programme link that fits', () => {
    const few = [{ ...alertGroupOf([classified('sentinel', 'one.example.org')]), group: 'Other' }];
    const links = buildAlertsLinks({ grafanaUrl: 'https://watchdog.example.org', alertGroups: few });
    const payload = buildPayload({
      brief, items: [item], runId: '2026-09-18', date: '2026-09-18', audience: 'internal', channel: 'C123',
      alertGroups: few, alertsLinks: links,
    });
    const reply = payload.replies.find((r) => r.kind === 'alerts');
    expect(reply.text).to.include(`<${links.byGroup.get('Other')}|alert list>`);
  });
});

describe('publish/payload: the report in the thread and the footer count (revisions 25 and 28)', () => {
  const body = makeItem({ rank: 1, placement: 'body' });
  const threadItem = makeItem({ metric: 'cht_conflict_count', severity: 'low', rank: 2, placement: 'thread' });
  const related = makeItem({
    metric: 'cht_outbound_push_backlog_count', severity: 'medium', rank: 3, placement: 'thread',
    relates_to: { item_id: body.item_id, metric: body.metric, relation: 'same_cause' },
  });
  const report = { path: 'rollup/report.html', slack_file_id: null, ts: null };
  const brief = makeBrief({ bullets: [{ item_id: body.item_id, text: 'alpha 912 vs 300' }], report });
  const args = () => ({
    brief, items: [body, threadItem, related], runId: '2026-09-18', date: '2026-09-18', audience: 'internal',
    channel: 'C123',
  });

  it('carries the report as a share into the thread with a code-built comment that says how to cite an item', () => {
    const payload = buildPayload(args());
    expect(payload.report).to.include({
      filename: 'report-2026-09-18.html', path: 'rollup/report.html', items: 3, slack_file_id: null, ts: null,
    });
    expect(payload.report, 'no reply count since revision 28').to.not.have.property('replied');
    expect(payload.report.title).to.include('2026-09-18');
    expect(payload.report.initial_comment).to.include('Full report: 3 items');
    expect(payload.report.initial_comment).to.include('#2').and.include('host and metric');
    expect(payload.report.initial_comment).to.match(/👍|:\+1:/);
  });

  it('counts covered items as in the body and says in the footer how many are only in the report', () => {
    const payload = buildPayload(args());
    const footer = payload.parent.blocks[payload.parent.blocks.length - 1].elements[0].text;
    expect(footer).to.include('run 2026-09-18 · 2 more items in the report (thread)');
    // A line covering two items of one project (revision 28) leaves one item only in the report.
    const covering = makeBrief({
      bullets: [{ item_id: body.item_id, item_ids: [body.item_id, related.item_id], text: 'alpha 912 vs 300' }],
      report,
    });
    const covered = buildPayload({ ...args(), brief: covering });
    const footerCovered = covered.parent.blocks[covered.parent.blocks.length - 1].elements[0].text;
    expect(footerCovered).to.include('run 2026-09-18 · 1 more item in the report (thread)');
    expect(covered.report.initial_comment).to.include('#2');
    const all = buildPayload({ ...args(), items: [body] });
    const footerAll = all.parent.blocks[all.parent.blocks.length - 1].elements[0].text;
    expect(footerAll).to.not.include('more items');
    expect(footerAll.endsWith('run 2026-09-18')).to.equal(true);
  });

  it('carries no report when the brief has none, nor on a heartbeat or a failure', () => {
    const none = buildPayload({ ...args(), brief: makeBrief({ bullets: [{ item_id: body.item_id, text: 'x' }] }) });
    expect(none.report).to.equal(null);
    const heartbeat = buildPayload({
      ...args(), brief: makeBrief({ kind: 'heartbeat', headline: 'All quiet', bullets: [], report }), items: [],
    });
    expect(heartbeat.report).to.equal(null);
  });
});
