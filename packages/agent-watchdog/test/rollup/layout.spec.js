// The body and thread layout (FR-010, FR-020, FR-069, revision 28): two programme slots of three project lines, a
// reply per remaining programme with two or more flagged projects, one Other reply, and alerts in no slot.
const {
  buildLayout, groupOfProjects, groupBulletText, moreProjectsText, assembleBullets, assembleThread, slotByKey,
  coveredIds, childPrefixes, shortHostLabel, stripLeadingHost, BODY_SLOTS, MAX_PROJECTS, OWN_REPLY_MIN_PROJECTS,
  MAX_CHILDREN, UNGROUPED, replyKindOf,
} = require('../../src/rollup/layout');

const id = (letter) => letter.repeat(12);
const item = (letter, host) => ({ item_id: id(letter), project_url: `https://${host}` });
const groupOf = (url) => {
  if (url.includes('north')) {
    return 'North Programme';
  }
  if (url.includes('south')) {
    return 'South Programme';
  }
  if (url.includes('east')) {
    return 'East Programme';
  }
  return UNGROUPED;
};
// Rank order: north-a, north-b, north-a again, south-a, alpha (ungrouped), east-a, east-b, beta (ungrouped), north-c,
// north-d, north-e.
const items = [
  item('a', 'north-a.example.org'), item('b', 'north-b.example.org'), item('c', 'north-a.example.org'),
  item('d', 'south-a.example.org'), item('e', 'alpha.example.org'), item('f', 'east-a.example.org'),
  item('g', 'east-b.example.org'), item('h', 'beta.example.org'), item('i', 'north-c.example.org'),
  item('j', 'north-d.example.org'), item('k', 'north-e.example.org'),
];

describe('rollup/layout', () => {
  it('exposes the limits from the spec', () => {
    expect(BODY_SLOTS).to.equal(2);
    expect(MAX_PROJECTS).to.equal(3);
    expect(OWN_REPLY_MIN_PROJECTS).to.equal(2);
    expect(MAX_CHILDREN).to.equal(4);
  });

  it('fills the body with the two highest-ranked programmes, three project lines each, and counts the rest', () => {
    const layout = buildLayout(items, { groupOf });
    const summary = layout.slots.map((s) => [s.kind, s.group, s.projects_total, s.issues_total, s.more_projects]);
    expect(summary).to.deep.equal([
      ['group', 'North Programme', 5, 6, 2], ['item', 'South Programme', 1, 1, 0],
    ]);
    const [north] = layout.slots;
    expect(north.entries.map((e) => [e.lead_id, e.item_ids, e.host, e.prefix])).to.deep.equal([
      [id('a'), [id('a'), id('c')], 'north-a.example.org', 'north-a: '],
      [id('b'), [id('b')], 'north-b.example.org', 'north-b: '],
      [id('i'), [id('i')], 'north-c.example.org', 'north-c: '],
    ]);
    expect(north.item_ids).to.deep.equal([id('a'), id('b'), id('i')]);
    expect(layout.slots[1].entries[0].prefix).to.equal('south-a.example.org: ');
    expect(layout.body_items).to.deep.equal([id('a'), id('b'), id('i'), id('d')]);
  });

  it('gives a programme outside the body its own reply at two projects or more, the rest an Other reply', () => {
    const layout = buildLayout(items, { groupOf });
    expect(layout.replies.map((r) => [r.kind, r.group, r.entries.map((e) => e.host)])).to.deep.equal([
      ['programme', 'East Programme', ['east-a.example.org', 'east-b.example.org']],
      ['other', UNGROUPED, ['alpha.example.org', 'beta.example.org']],
    ]);
    expect(layout.reply_items).to.deep.equal([id('f'), id('g'), id('e'), id('h')]);
    // North's fourth and fifth projects are in the report only, as are the Other and East items.
    expect(layout.thread_items).to.deep.equal([id('e'), id('f'), id('g'), id('h'), id('j'), id('k')]);
    expect(layout.one_line).to.deep.equal([]);
  });

  it('treats an ungrouped project as a unit of one for the body, so the day\'s top item is never buried', () => {
    const reordered = [item('e', 'alpha.example.org'), ...items.filter((i) => i.item_id !== id('e'))];
    const layout = buildLayout(reordered, { groupOf });
    expect(layout.slots[0]).to.include({ kind: 'item', group: UNGROUPED });
    expect(layout.slots[0].entries[0].prefix).to.equal('alpha.example.org: ');
    expect(layout.slots[1].group).to.equal('North Programme');
    expect(layout.replies.map((r) => r.kind)).to.deep.equal(['programme', 'other']);
    expect(layout.replies[1].entries.map((e) => e.host)).to.deep.equal(['south-a.example.org', 'beta.example.org']);
  });

  it('describes every entry for the prompt and the gate, and lists the alert keys for the thread', () => {
    const layout = buildLayout(items, { groupOf, alertGroups: [{ alert_key: 'North Programme/backlog' }] });
    expect(layout.entries[id('a')]).to.deep.equal({
      item_ids: [id('a'), id('c')], host: 'north-a.example.org', prefix: 'north-a: ', budget: 111, where: 'body',
      group: 'North Programme',
    });
    expect(layout.entries[id('f')]).to.include({ where: 'reply', group: 'East Programme', budget: 112 });
    expect(coveredIds(layout, id('a'))).to.deep.equal([id('a'), id('c')]);
    expect(coveredIds(layout, id('z'))).to.deep.equal([id('z')]);
    expect([...childPrefixes(layout).entries()].slice(0, 2))
      .to.deep.equal([[id('a'), 'north-a: '], [id('b'), 'north-b: ']]);
    expect(layout.body_alerts).to.deep.equal([]);
    expect(layout.thread_alerts).to.deep.equal(['North Programme/backlog']);
  });

  it('maps every item a body line covers to its slot, for placement', () => {
    const slots = slotByKey(buildLayout(items, { groupOf }));
    expect([slots.get(id('a')), slots.get(id('c')), slots.get(id('d'))]).to.deep.equal([1, 1, 2]);
    expect(slots.has(id('e'))).to.equal(false);
    expect(slots.has(id('j'))).to.equal(false);
  });

  it('assembles the body bullets and the thread bullets with the project written by code and the count line', () => {
    const layout = buildLayout(items, { groupOf });
    const textFor = (leadId) => `line for ${leadId[0]}`;
    const bullets = assembleBullets({ layout, textFor, prefixHosts: true });
    expect(bullets[0]).to.deep.include({ kind: 'group', item_id: null, group: 'North Programme', alert_key: null });
    expect(bullets[0].text).to.equal('North Programme: 5 projects with 6 issues');
    expect(bullets[0].children).to.deep.equal([
      { item_id: id('a'), item_ids: [id('a'), id('c')], text: 'north-a: line for a' },
      { item_id: id('b'), item_ids: [id('b')], text: 'north-b: line for b' },
      { item_id: id('i'), item_ids: [id('i')], text: 'north-c: line for i' },
      { item_id: null, item_ids: [], text: '+2 more projects in the report' },
    ]);
    expect(bullets[1]).to.deep.include({
      kind: 'item', item_id: id('d'), item_ids: [id('d')], text: 'south-a.example.org: line for d', children: [],
    });
    const thread = assembleThread({ layout, textFor, prefixHosts: true });
    expect(thread.map((b) => [replyKindOf(b), b.text])).to.deep.equal([
      ['programme', 'East Programme: 2 projects with issues'], ['other', 'Other: 2 projects with issues'],
    ]);
    expect(thread[1].children.map((c) => c.text)).to.deep.equal(['alpha: line for e', 'beta: line for h']);
    const plain = assembleBullets({ layout, textFor });
    expect(plain[0].children[0].text).to.equal('line for a');
  });

  it('writes the group and count lines by code', () => {
    expect(groupBulletText({ label: 'North', projects: 3, issues: 3 })).to.equal('North: 3 projects with issues');
    expect(groupBulletText({ label: 'North', projects: 1, issues: 2 })).to.equal('North: 1 project with 2 issues');
    expect(moreProjectsText(1)).to.equal('+1 more project in the report');
    expect(moreProjectsText(4)).to.equal('+4 more projects in the report');
  });

  it('maps a project url to its group label, Other when unknown', () => {
    const groupFor = groupOfProjects({ projects: [{ url: 'https://north-a.example.org', group: 'North Programme' }] });
    expect(groupFor('https://north-a.example.org')).to.equal('North Programme');
    expect(groupFor('https://nowhere.example.org')).to.equal(UNGROUPED);
  });

  it('names a group member by its first label, two on a clash, and never writes a host the model wrote twice', () => {
    expect(shortHostLabel('a.north.example', ['a.north.example', 'b.north.example'])).to.equal('a');
    expect(shortHostLabel('cht.north.example.org', ['cht.north.example.org', 'cht.south.example.org']))
      .to.equal('cht.north');
    expect(stripLeadingHost('North-a: backlog 912', 'north-a.example.org', 'north-a')).to.equal('backlog 912');
    expect(stripLeadingHost('north-a backlog 912', 'north-a.example.org', 'north-a')).to.equal('backlog 912');
    expect(stripLeadingHost('backlog 912 on north-a', 'north-a.example.org', 'north-a'))
      .to.equal('backlog 912 on north-a');
    const layout = buildLayout(items.slice(0, 3), { groupOf });
    const texts = { [id('a')]: 'North-a: backlog 912', [id('b')]: 'north-b.example.org — backlog 400' };
    const [north] = assembleBullets({ layout, textFor: (leadId) => texts[leadId], prefixHosts: true });
    expect(north.children.map((c) => c.text)).to.deep.equal(['north-a: backlog 912', 'north-b: backlog 400']);
  });
});
