const fs = require('node:fs');
const path = require('node:path');
const { renderReport, assertNoTripleStash, sparklineSvg } = require('../../src/render/report');
const { makeItem, makeBrief, makeDiscovery, footer } = require('../rollup/factories');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : [full];
});

describe('render/report', () => {
  const item = makeItem({ why_now: 'Backlog <script>alert(1)</script> & rising' });
  const brief = makeBrief({
    bullets: [{ item_id: item.item_id, text: 'alpha sentinel backlog 912 vs 300 & climbing' }],
  });
  const windows = new Map([[`${item.project_url}|${item.metric}`, [300, 320, 500, 700, 912]]]);
  const base = { changes: {}, discovery: makeDiscovery(), runId: '2026-09-18' };

  it('renders a self-contained page with the summary element, headline, bullets and per-item evidence', () => {
    const html = renderReport({ ...base, brief, items: [item], windowsByMetric: windows });
    expect(html).to.include('id="brief-summary"');
    expect(html).to.include('Sentinel backlog tripled on alpha');
    expect(html).to.include('912');
    expect(html).to.include('cht_sentinel_backlog_count');
    expect(html).to.not.match(/<script/);
    expect(html).to.not.match(/src="http|href="http/);
    expect(html).to.include('<svg');
    expect(html).to.include('<polyline');
  });

  it('renders the code-placed markers on the headline and bullets (FR-082)', () => {
    const html = renderReport({ ...base, brief, items: [item], windowsByMetric: windows });
    expect(html).to.include('📋 Sentinel backlog tripled on alpha');
    expect(html).to.include('🔴 alpha sentinel backlog 912 vs 300');
  });

  it('escapes untrusted text everywhere it appears', () => {
    const html = renderReport({ ...base, brief, items: [item], windowsByMetric: windows });
    expect(html).to.include('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).to.include('912 vs 300 &amp; climbing');
  });

  it('compiles in strict mode, so a missing view field is an error rather than a blank', () => {
    const broken = { ...brief, headline: undefined };
    expect(() => renderReport({ ...base, brief: broken, items: [item], windowsByMetric: windows })).to.throw();
  });

  it('renders a heartbeat and a degraded brief without items', () => {
    const quiet = makeBrief({ kind: 'heartbeat', headline: 'All quiet', bullets: [] });
    const html = renderReport({ ...base, brief: quiet, items: [], windowsByMetric: new Map() });
    expect(html).to.include('All quiet');
    const degraded = makeBrief({
      kind: 'degraded', bullets: [], degradation_notice: 'Degraded: gate rejected three drafts',
    });
    const html2 = renderReport({ ...base, brief: degraded, items: [], windowsByMetric: new Map() });
    expect(html2).to.include('gate rejected three drafts');
  });

  it('refuses triple-stash anywhere in the templates and in the guard', () => {
    expect(() => assertNoTripleStash('<p>{{{raw}}}</p>')).to.throw(/triple/);
    for (const file of walk(TEMPLATES)) {
      expect(fs.readFileSync(file, 'utf8'), file).to.not.include('{{{');
    }
  });

  it('builds sparklines from numbers only', () => {
    const svg = sparklineSvg([1, 2, '<b>', 3, null, NaN]).toString();
    expect(svg).to.include('<polyline');
    expect(svg).to.not.include('<b>');
    expect(sparklineSvg([]).toString()).to.equal('');
  });
});

describe('render/report: sub-bullets (User Story 9)', () => {
  it('renders a group bullet with its sub-bullets as a nested list, escaped', () => {
    const grouped = makeBrief({
      bullets: [{
        kind: 'group', item_id: null, group: 'North Programme', text: 'North Programme: 2 projects with issues',
        alert_key: null,
        children: [
          { item_id: 'a'.repeat(12), text: 'north-a backlog 912 vs 300 <b>' },
          { item_id: 'b'.repeat(12), text: 'north-b backlog 400 vs 100' },
        ],
      }],
    });
    const html = renderReport({
      brief: grouped, items: [], windowsByMetric: new Map(), discovery: makeDiscovery(), runId: 'r',
    });
    expect(html).to.include('North Programme: 2 projects with issues');
    const sub = html.slice(html.indexOf('<ul class="sub">'), html.indexOf('</ul>', html.indexOf('<ul class="sub">')));
    expect(sub).to.include('north-a backlog 912 vs 300 &lt;b&gt;').and.include('north-b backlog 400 vs 100');
    expect(html).to.not.include('<b>');
  });
});

describe('render/report: ranks, identities, related items and standing conditions (revision 23)', () => {
  const primary = makeItem({ rank: 1, placement: 'body' });
  const related = makeItem({
    metric: 'cht_outbound_push_backlog_count', severity: 'medium', rank: 3, placement: 'thread',
    relates_to: { item_id: primary.item_id, metric: primary.metric, relation: 'same_cause' },
  });
  const other = makeItem({ metric: 'cht_conflict_count', severity: 'low', rank: 2, placement: 'thread' });
  const brief = makeBrief({ bullets: [{ item_id: primary.item_id, text: 'alpha 912 vs 300' }] });
  const base = { brief, windowsByMetric: new Map(), discovery: makeDiscovery(), runId: '2026-09-18' };

  it('numbers every item by rank, shows its identity and says how to cite one', () => {
    const html = renderReport({ ...base, items: [primary, other, related] });
    expect(html).to.include('#1').and.include('#2').and.include('#3');
    expect(html).to.include(primary.item_id).and.include(other.item_id);
    expect(html).to.match(/cite an item/i);
  });

  it('nests an item under the higher-ranked item it relates to, once, with the relation', () => {
    const html = renderReport({ ...base, items: [primary, other, related] });
    const first = html.indexOf('cht_outbound_push_backlog_count');
    expect(html.indexOf('cht_outbound_push_backlog_count', first + 1), 'the related item appears once').to.equal(-1);
    const primarySection = html.slice(html.indexOf('#1'), html.indexOf('#2'));
    expect(primarySection).to.include('cht_outbound_push_backlog_count').and.include('same cause');
    expect(html).to.include('class="related"');
  });

  it('nests a relation chain at any depth, each item once (revision 34)', () => {
    const grandchild = makeItem({
      metric: 'cht_couchdb_doc_total', severity: 'low', rank: 4, placement: 'thread',
      relates_to: { item_id: related.item_id, metric: related.metric, relation: 'consequence_of' },
    });
    const html = renderReport({ ...base, items: [primary, other, related, grandchild] });
    const rank = (n) => (html.match(new RegExp(`class="rank">#${n}<`, 'g')) || []).length;
    expect(rank(4), 'the grandchild appears once').to.equal(1);
    expect(rank(3)).to.equal(1);
    // The grandchild's list item sits inside the related item's, which sits inside the primary's card.
    const grandchildAt = html.indexOf('class="rank">#4<');
    const relatedAt = html.indexOf('class="rank">#3<');
    const primaryEnd = html.indexOf('</section>', html.indexOf('class="rank">#1<'));
    expect(relatedAt).to.be.lessThan(grandchildAt);
    expect(grandchildAt).to.be.lessThan(primaryEnd);
    expect(html).to.include('consequence of');
    expect((html.match(/<ul class="related">/g) || []).length).to.equal(2);
  });

  it('lists standing conditions per host when given, and omits the section otherwise', () => {
    const standing = [{
      rule: 'backlog_absolute', project_url: 'https://north-a.example.org', host: 'north-a.example.org',
      group: 'North Programme', metric: 'cht_outbound_push_backlog_count', value: 1234, previous_day_value: 1200,
    }];
    const html = renderReport({ ...base, items: [primary], standing });
    expect(html).to.include('Standing conditions').and.include('north-a.example.org').and.include('1,234')
      .and.include('North Programme');
    expect(renderReport({ ...base, items: [primary] })).to.not.include('Standing conditions');
  });
});

describe('render/report: the original design with its links, one footer and rounding (FR-022, revision 25)', () => {
  const { roundForReading } = require('../../src/render/report');
  const first = makeItem({ rank: 1, placement: 'body' });
  const second = makeItem({ metric: 'cht_conflict_count', severity: 'low', rank: 2, placement: 'thread' });
  const brief = makeBrief({
    bullets: [{ item_id: first.item_id, text: 'alpha sentinel backlog 912 vs 300 & climbing' }],
    footer: { ...footer(), trace_url: 'https://langfuse.example.org/trace/t1' },
  });
  const standing = [{
    rule: 'backlog_absolute', project_url: 'https://beta.example.org', host: 'beta.example.org', group: 'Other',
    metric: 'cht_outbound_push_backlog_count', value: 1234, previous_day_value: 1200.4567,
    panel_ref: { dashboard_uid: 'oa2OfL-Vk', panel_id: 2, panel_title: 'Outbound Push Backlog', ref_id: 'A' },
  }];
  const alertGroups = [{
    alert_key: 'North Programme/backlog', group: 'North Programme', category: 'backlog', importance: 'high',
    firing: 2, stale: 1, new: 0, hosts: ['north-a.example.org', 'north-b.example.org'], titles: ['Sentinel Backlog'],
    instances: [
      {
        instance_id: 'i1', title: 'Sentinel Backlog', host: 'north-a.example.org',
        started_at: '2026-09-15T06:00:00Z', days_firing: 3, stale: false, new: false,
      },
      {
        instance_id: 'i2', title: 'Sentinel Backlog', host: 'north-b.example.org',
        started_at: '2026-08-20T00:00:00Z', days_firing: 29, stale: true, new: false,
      },
    ],
  }];
  const runStart = new Date('2026-09-18T06:00:00Z');
  const internal = { mode: 'internal', grafanaUrl: 'https://watchdog.example.org', runStart };
  const base = {
    brief, items: [first, second], windowsByMetric: new Map(), discovery: makeDiscovery(), runId: '2026-09-18',
    standing, alertGroups,
  };

  it('heads each item with its number, severity, host, metric and persistence, the id apart, never "rank N"', () => {
    const html = renderReport({ ...base, links: internal });
    const head = html.slice(html.indexOf('class="head"'), html.indexOf('class="confidence"'));
    expect(head).to.include('#1').and.include('HIGH').and.include('alpha.example.org')
      .and.include('cht_sentinel_backlog_count').and.include('new today').and.include(first.item_id);
    expect(head).to.not.match(/rank 1/);
    expect(html).to.not.match(/rank \d/);
    expect(html).to.not.include('Items by rank').and.not.include('Persistence');
  });

  it('puts the confidence on its own line under the number', () => {
    const html = renderReport({ ...base, links: internal });
    const confidence = html.slice(html.indexOf('class="confidence"'), html.indexOf('class="evidence"'));
    expect(confidence).to.include('confidence 85%');
    expect(html.indexOf('class="head"')).to.be.lessThan(html.indexOf('class="confidence"'));
  });

  it('keeps the window names as the run records them and rounds evidence values and notes', () => {
    const noted = makeItem({
      rank: 1, placement: 'body',
      evidence: [
        { window: 'current', value: 912, unit: 'count' },
        { window: 'previous_day', value: 300, unit: 'count' },
        {
          window: 'trailing_14d', value: 811.25, unit: 'count',
          note: 'mean of trailing daily values; stddev 3.2031234756093934',
        },
      ],
    });
    const html = renderReport({ ...base, items: [noted], links: internal });
    expect(html).to.include('previous_day').and.include('trailing_14d');
    expect(html).to.not.include('previous day');
    expect(html).to.include('stddev 3.203').and.not.include('3.2031234756093934');
    expect(html).to.include('1,200.457');
  });

  it('links each item, standing host and alert group and the footer when links are internal', () => {
    const html = renderReport({ ...base, links: internal });
    expect(html).to.include('href="https://watchdog.example.org/d/oa2OfL-Vk/cht-admin-overview?');
    expect(html).to.include('var-cht_instance=alpha.example.org');
    expect(html).to.include('var-cht_instance=beta.example.org');
    expect(html).to.include('/alerting/list?search=');
    expect(html).to.include('href="https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/specs/001-watchdog-slack-loop"');
    expect(html).to.include('>specs</a>');
    expect(html).to.include('href="https://github.com/medic/medic-infrastructure"');
    expect(html).to.include('href="https://langfuse.example.org/trace/t1"');
    expect(html).to.include('run 2026-09-18').and.include('$0.12');
    expect(html).to.match(/cite an item/i);
    expect(html).to.not.include('prompts');
  });

  it('names everything and links nothing when links are none', () => {
    const html = renderReport({ ...base, links: { mode: 'none', grafanaUrl: 'https://watchdog.example.org', runStart } });
    expect(html).to.not.include('href=');
    expect(html).to.include('beta.example.org').and.include('North Programme').and.include('Sentinel Backlog');
    expect(html).to.include('trace').and.include('specs');
  });

  it('lists the alert groups the brief covered with their instances, in a card like the standing conditions', () => {
    const html = renderReport({ ...base, links: internal });
    expect(html).to.include('<h2>Alerts</h2>');
    expect(html).to.include('north-a.example.org').and.include('north-b.example.org');
    expect(html).to.include('2 firing');
  });

  it('rounds numbers for reading: three decimals, three significant figures below one, integers grouped', () => {
    expect(roundForReading(1234.56789)).to.equal('1,234.568');
    expect(roundForReading(0.0008130081300813008)).to.equal('0.000813');
    expect(roundForReading(912)).to.equal('912');
    expect(roundForReading(1234)).to.equal('1,234');
    expect(roundForReading(3.5)).to.equal('3.5');
    expect(roundForReading(-2.75429143673639)).to.equal('-2.754');
    const long = makeItem({
      rank: 1, placement: 'body', why_now: 'Deviation 3.980246763660453σ and a rate of 0.0008130081300813008 docs/day',
    });
    const html = renderReport({ ...base, items: [long], links: internal });
    expect(html).to.include('3.98σ').and.include('0.000813 docs/day');
    expect(html).to.not.include('3.980246763660453');
  });

  it('stays self-contained in the original design: summary and item cards, no script, no external asset', () => {
    const html = renderReport({ ...base, links: internal });
    expect(html).to.include('id="brief-summary"').and.include('<section class="item">');
    expect(html).to.not.match(/<script|src="http|@import|fonts\.googleapis/);
    expect(html).to.not.include('{{{');
    expect(fs.readFileSync(path.join(TEMPLATES, 'report.hbs'), 'utf8')).to.match(/Design read/i);
  });
});
