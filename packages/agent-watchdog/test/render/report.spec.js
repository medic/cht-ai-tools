const fs = require('node:fs');
const path = require('node:path');
const { renderReport, assertNoTripleStash, sparklineSvg } = require('../../src/render/report');
const { makeItem, makeBrief, makeDiscovery } = require('../rollup/factories');

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

  it('lists standing conditions per host when given, and omits the section otherwise', () => {
    const standing = [{
      rule: 'backlog_absolute', project_url: 'https://north-a.example.org', host: 'north-a.example.org',
      group: 'North Programme', metric: 'cht_outbound_push_backlog_count', value: 1234, previous_day_value: 1200,
    }];
    const html = renderReport({ ...base, items: [primary], standing });
    expect(html).to.include('Standing conditions').and.include('north-a.example.org').and.include('1234')
      .and.include('North Programme');
    expect(renderReport({ ...base, items: [primary] })).to.not.include('Standing conditions');
  });
});
