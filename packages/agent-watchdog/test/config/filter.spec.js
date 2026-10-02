// The one helper every stage and the presentation scope use to restrict a run (FR-087, revision 24): hosts by
// `--project`, whole programmes by `--group`, or everything.
const { selectProjects, filterIsActive } = require('../../src/config/filter');

const projects = [
  { host: 'north-a.example.org', url: 'https://north-a.example.org', slug: 'north-a-example-org', group: 'North Programme' },
  { host: 'north-b.example.org', url: 'https://north-b.example.org', slug: 'north-b-example-org', group: 'North Programme' },
  { host: 'south-a.example.org', url: 'https://south-a.example.org', slug: 'south-a-example-org', group: 'South Programme' },
  { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org', group: 'Other' },
];

describe('config/filter selectProjects', () => {
  it('returns every project when no filter is given', () => {
    expect(selectProjects(projects, {})).to.deep.equal(projects);
    expect(selectProjects(projects, { project: [], group: [] })).to.deep.equal(projects);
    expect(filterIsActive({})).to.equal(false);
  });

  it('selects every project of a programme by its label, exactly and case-insensitively', () => {
    expect(selectProjects(projects, { group: ['north programme'] }).map((p) => p.host))
      .to.deep.equal(['north-a.example.org', 'north-b.example.org']);
    expect(selectProjects(projects, { group: ['North'] })).to.deep.equal([]);
    expect(filterIsActive({ group: ['North Programme'] })).to.equal(true);
  });

  it('still selects hosts by --project, written as a host or a URL, and unions both flags', () => {
    expect(selectProjects(projects, { project: ['https://ALPHA.example.org/'] }).map((p) => p.host))
      .to.deep.equal(['alpha.example.org']);
    const both = selectProjects(projects, { project: ['south-a.example.org'], group: ['North Programme'] });
    expect(both.map((p) => p.host))
      .to.deep.equal(['north-a.example.org', 'north-b.example.org', 'south-a.example.org']);
  });

  it('selects nothing for an unknown label rather than falling back to everything', () => {
    expect(selectProjects(projects, { group: ['Nowhere'] })).to.deep.equal([]);
  });
});
