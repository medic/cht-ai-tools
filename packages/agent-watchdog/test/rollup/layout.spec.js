// The body layout rule (data-model.md Bullet; FR-010, FR-069): five top-level slots, a programme's items collapse
// into one slot with at most eight sub-bullets, "Other" never collapses, the rest go to the thread.
const {
  layoutEntries, buildLayout, groupOfProjects, groupBulletText, assembleBullets, BODY_SLOTS, MAX_CHILDREN, UNGROUPED,
} = require('../../src/rollup/layout');
const { rankItems } = require('../../src/rollup/rank');
const { makeItem, makeDiscovery, makeProject } = require('./factories');

const entry = (key, group) => ({ key, group });

describe('rollup/layout layoutEntries', () => {
  it('exposes the limits from the spec', () => {
    expect(BODY_SLOTS).to.equal(5);
    expect(MAX_CHILDREN).to.equal(8);
    expect(UNGROUPED).to.equal('Other');
  });

  it('gives ungrouped entries one slot each, five in the body and the rest in the thread', () => {
    const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => entry(k, 'Other'));
    const layout = layoutEntries(entries);
    expect(layout.slots).to.have.length(5);
    expect(layout.slots.map((s) => s.kind)).to.deep.equal(['item', 'item', 'item', 'item', 'item']);
    expect(layout.slots.map((s) => s.slot)).to.deep.equal([1, 2, 3, 4, 5]);
    expect(layout.body).to.deep.equal(['a', 'b', 'c', 'd', 'e']);
    expect(layout.thread).to.deep.equal(['f', 'g']);
    expect(layout.one_line).to.deep.equal([]);
  });

  it('collapses a programme with several entries into one group slot, children in rank order', () => {
    const entries = [entry('a', 'MoH Nepal'), entry('b', 'eCHIS Kenya'), entry('c', 'MoH Nepal'), entry('d', 'Other')];
    const layout = layoutEntries(entries);
    expect(layout.slots.map((s) => [s.slot, s.kind, s.group, s.keys])).to.deep.equal([
      [1, 'group', 'MoH Nepal', ['a', 'c']],
      [2, 'item', 'eCHIS Kenya', ['b']],
      [3, 'item', 'Other', ['d']],
    ]);
    // Body order follows the slots, not the raw rank order.
    expect(layout.body).to.deep.equal(['a', 'c', 'b', 'd']);
    expect(layout.one_line).to.deep.equal(['a', 'c']);
    expect(layout.thread).to.deep.equal([]);
  });

  it('never collapses the reserved Other group', () => {
    const layout = layoutEntries(['a', 'b', 'c'].map((k) => entry(k, 'Other')));
    expect(layout.slots).to.have.length(3);
    expect(layout.slots.every((s) => s.kind === 'item')).to.equal(true);
  });

  it('sends the ninth member of a programme to the thread rather than opening a second slot', () => {
    const nepal = Array.from({ length: 10 }, (_, i) => entry(`n${i}`, 'MoH Nepal'));
    const layout = layoutEntries([...nepal, entry('k', 'eCHIS Kenya')]);
    expect(layout.slots).to.have.length(2);
    expect(layout.slots[0].keys).to.have.length(8);
    expect(layout.slots[1]).to.include({ kind: 'item', group: 'eCHIS Kenya' });
    expect(layout.thread).to.deep.equal(['n8', 'n9']);
  });

  it('lets a programme join its slot even when the five slots are already open', () => {
    const entries = [
      entry('a', 'MoH Nepal'), entry('b', 'Other'), entry('c', 'Other'), entry('d', 'Other'), entry('e', 'Other'),
      entry('f', 'Other'), entry('g', 'MoH Nepal'),
    ];
    const layout = layoutEntries(entries);
    expect(layout.slots[0].keys).to.deep.equal(['a', 'g']);
    expect(layout.thread).to.deep.equal(['f']);
  });

  it('accepts other limits for the tests of the gate', () => {
    const layout = layoutEntries(['a', 'b', 'c'].map((k) => entry(k, 'Other')), { slots: 2 });
    expect(layout.body).to.deep.equal(['a', 'b']);
    expect(layout.thread).to.deep.equal(['c']);
  });
});

describe('rollup/layout buildLayout and groupOfProjects', () => {
  const discovery = makeDiscovery({
    projects: [
      makeProject('nepal-a.example.org', { group: 'MoH Nepal' }),
      makeProject('nepal-b.example.org', { group: 'MoH Nepal' }),
      makeProject('echis-a.example.org', { group: 'eCHIS Kenya' }),
      makeProject('alpha.example.org'),
    ],
  });
  const items = rankItems({
    items: [
      makeItem({ project_url: 'https://nepal-a.example.org', confidence: 0.9 }),
      makeItem({ project_url: 'https://echis-a.example.org', confidence: 0.8 }),
      makeItem({ project_url: 'https://nepal-b.example.org', confidence: 0.7 }),
      makeItem({ project_url: 'https://alpha.example.org', confidence: 0.6 }),
    ],
    groupOf: groupOfProjects(discovery),
  });

  it('maps a project url to its group label, Other when unknown', () => {
    const groupOf = groupOfProjects(discovery);
    expect(groupOf('https://nepal-a.example.org')).to.equal('MoH Nepal');
    expect(groupOf('https://alpha.example.org')).to.equal('Other');
    expect(groupOf('https://unknown.example.org')).to.equal('Other');
  });

  it('writes the layout document: slots with item ids and one-line flags, body, thread', () => {
    const layout = buildLayout(items, { groupOf: groupOfProjects(discovery) });
    expect(layout.slots).to.have.length(3);
    expect(layout.slots[0]).to.deep.include({ slot: 1, kind: 'group', group: 'MoH Nepal', one_line: true });
    expect(layout.slots[0].item_ids).to.deep.equal([items[0].item_id, items[2].item_id]);
    expect(layout.slots[1]).to.deep.include({ slot: 2, kind: 'item', group: 'eCHIS Kenya', one_line: false });
    expect(layout.body_items).to.deep.equal([items[0].item_id, items[2].item_id, items[1].item_id, items[3].item_id]);
    expect(layout.thread_items).to.deep.equal([]);
    expect(layout.one_line).to.deep.equal([items[0].item_id, items[2].item_id]);
  });

  it('ranks items with slot and placement from the same rule', () => {
    expect(items.map((i) => i.rank)).to.deep.equal([1, 2, 3, 4]);
    expect(items.map((i) => i.slot)).to.deep.equal([1, 2, 1, 3]);
    expect(items.every((i) => i.placement === 'body')).to.equal(true);
  });

  it('writes the group line by code from the member count', () => {
    const text = (projects, issues) => groupBulletText({ label: 'MoH Nepal', projects, issues });
    expect(text(3, 3)).to.equal('MoH Nepal: 3 projects with issues');
    expect(text(1, 2)).to.equal('MoH Nepal: 1 project with 2 issues');
    expect(text(2, 3)).to.equal('MoH Nepal: 2 projects with 3 issues');
  });
});

describe('rollup/layout: alert groups (FR-066, User Story 8)', () => {
  const { interleaveAlerts, alertsBulletText, alertCategoryLine } = require('../../src/rollup/layout');
  const { classified, groupOf: alertGroupOf } = require('../helpers/alerts');
  const nepalBacklog = alertGroupOf([
    classified('sentinel', 'nepal-a.example.org', { new: true }),
    classified('sentinel', 'nepal-b.example.org', { started_at: '2026-08-20T00:00:00Z' }),
  ]);
  const nepalAvailability = alertGroupOf([classified('apiDown', 'nepal-b.example.org')]);
  const nepalDatabase = alertGroupOf([classified('fragmentation', 'nepal-c.example.org')]);
  const echisMessaging = alertGroupOf([classified('delivery', 'echis-a.example.org')]);
  const watchdog = alertGroupOf([classified('watchdog', null)]);
  const items = [
    makeItem({ project_url: 'https://alpha.example.org', severity: 'high', confidence: 0.9, rank: 1 }),
    makeItem({ project_url: 'https://beta.example.org', severity: 'medium', confidence: 0.8, rank: 2 }),
    makeItem({ project_url: 'https://gamma.example.org', severity: 'low', confidence: 0.7, rank: 3 }),
  ];

  it('ranks alert groups among items by importance: critical first, otherwise after items of the same severity', () => {
    const entries = interleaveAlerts(items, [nepalBacklog, nepalDatabase, echisMessaging, watchdog, nepalAvailability]);
    expect(entries.map((e) => (e.type === 'alerts' ? e.key : e.key.slice(0, 4)))).to.deep.equal([
      'MoH Nepal/availability',
      items[0].item_id.slice(0, 4), 'MoH Nepal/backlog', 'eCHIS Kenya/messaging',
      items[1].item_id.slice(0, 4), 'Watchdog/uncategorised',
      items[2].item_id.slice(0, 4), 'MoH Nepal/database',
    ]);
  });

  it('gives one alerts slot per programme with a sub-bullet per category, never mixing alerts with items', () => {
    const layout = buildLayout(items, {
      groupOf: () => 'Other', alertGroups: [nepalBacklog, nepalDatabase, echisMessaging, watchdog, nepalAvailability],
    });
    expect(layout.slots.map((s) => [s.slot, s.kind, s.group])).to.deep.equal([
      [1, 'alerts', 'MoH Nepal'], [2, 'item', 'Other'], [3, 'alerts', 'eCHIS Kenya'], [4, 'item', 'Other'],
      [5, 'alerts', 'Watchdog'],
    ]);
    expect(layout.slots[0].alert_keys)
      .to.deep.equal(['MoH Nepal/availability', 'MoH Nepal/backlog', 'MoH Nepal/database']);
    expect(layout.slots[0].item_ids).to.deep.equal([]);
    expect(layout.slots[1].alert_keys).to.deep.equal([]);
    expect(layout.body_items).to.deep.equal([items[0].item_id, items[1].item_id]);
    expect(layout.thread_items).to.deep.equal([items[2].item_id]);
    expect(layout.body_alerts).to.deep.equal([
      'MoH Nepal/availability', 'MoH Nepal/backlog', 'MoH Nepal/database', 'eCHIS Kenya/messaging',
      'Watchdog/uncategorised',
    ]);
    expect(layout.thread_alerts).to.deep.equal([]);
    expect(layout.one_line).to.deep.equal([]);
  });

  it('writes the alert bullet and category lines by code, with the staleness threshold spelled out', () => {
    expect(alertsBulletText({ label: 'MoH Nepal', firing: 15, stale: 3, staleAfterDays: 14 }))
      .to.equal('MoH Nepal alerts: 15 firing, 3 stale for more than 14 days');
    expect(alertsBulletText({ label: 'eCHIS Kenya', firing: 4, stale: 0, staleAfterDays: 14 }))
      .to.equal('eCHIS Kenya alerts: 4 firing, none stale');
    expect(alertCategoryLine(nepalBacklog)).to.equal(
      'backlog: 2 firing (Sentinel Backlog), oldest since 2026-08-20, 1 stale, 1 new',
    );
    expect(alertCategoryLine(nepalAvailability))
      .to.equal('availability: 1 firing (API Server Down), oldest since 2026-09-17');
    expect(alertCategoryLine(nepalBacklog).split('\n')).to.have.length(1);
  });

  it('assembles an alerts bullet from the layout with the group text and one child per category', () => {
    const alertGroups = [nepalBacklog, nepalAvailability, nepalDatabase];
    const layout = buildLayout([], { alertGroups });
    const bullets = assembleBullets({ layout, textFor: () => '', hostFor: () => '', alertGroups, staleAfterDays: 14 });
    expect(bullets).to.have.length(1);
    expect(bullets[0]).to.deep.include({
      kind: 'alerts', item_id: null, group: 'MoH Nepal', alert_key: 'MoH Nepal',
      text: 'MoH Nepal alerts: 4 firing, 1 stale for more than 14 days',
    });
    expect(bullets[0].children.map((c) => c.text)).to.deep.equal([
      'availability: 1 firing (API Server Down), oldest since 2026-09-17',
      'backlog: 2 firing (Sentinel Backlog), oldest since 2026-08-20, 1 stale, 1 new',
      'database: 1 firing (DB Fragmentation), oldest since 2026-09-17',
    ]);
    expect(bullets[0].children.every((c) => c.item_id === null)).to.equal(true);
    const single = assembleBullets({
      layout: buildLayout([], { alertGroups: [echisMessaging] }), textFor: () => '', hostFor: () => '',
      alertGroups: [echisMessaging], staleAfterDays: 14,
    });
    expect(single[0].alert_key).to.equal('eCHIS Kenya/messaging');
  });
});
