'use strict';
// FR-066 (revision 19): a run that analysed only some of the discovered projects briefs only those. The classified
// record and the durable episodes stay whole, so a narrow preview cannot disturb the next full run.
const { analysedHosts, scopeClassified, onAnalysedHosts } = require('../../src/rollup/scope');
const { classified: classifiedInstance, alertsPolicy, PROJECT_GROUPS } = require('../helpers/alerts');

const discovery = {
  projects: [
    { host: 'north-a.example.org', url: 'https://north-a.example.org', slug: 'north-a-example-org' },
    { host: 'north-b.example.org', url: 'https://north-b.example.org', slug: 'north-b-example-org' },
    { host: 'south-a.example.org', url: 'https://south-a.example.org', slug: 'south-a-example-org' },
  ],
  groups: [
    { label: 'North Programme', hosts: ['north-a.example.org', 'north-b.example.org'] },
    { label: 'South Programme', hosts: ['south-a.example.org'] },
  ],
};

// One firing alert on each of the three hosts, plus a stale housekeeping one on the untouched south host.
const instances = [
  classifiedInstance('sentinel', 'north-a.example.org'),
  classifiedInstance('outbound', 'north-b.example.org'),
  classifiedInstance('delivery', 'south-a.example.org'),
  classifiedInstance('apiDown', 'south-a.example.org', { stale: true, housekeeping: true, days_firing: 74 }),
];

const classifiedFile = () => ({
  available: true,
  reason: null,
  observed_at: '2026-09-18T06:00:00.000Z',
  ignored_hosts: [],
  stale_after_days: 14,
  rules: [],
  instances,
  groups: [],
  housekeeping: [{
    instance_id: instances[3].instance_id, title: 'API Server Down', host: 'south-a.example.org', days_firing: 74,
  }],
  counts: { firing: 3, new: 0, stale: 1, housekeeping: 1, pending: 0, unknown_rules: 0 },
});

describe('rollup/scope analysedHosts', () => {
  it('is null when the run analysed everything discovered, so nothing narrows', () => {
    expect(analysedHosts({ discovery, flags: {} })).to.equal(null);
    expect(analysedHosts({ discovery, flags: { project: [] } })).to.equal(null);
    // Every discovered host named explicitly is still the whole run.
    const all = discovery.projects.map((p) => p.url);
    expect(analysedHosts({ discovery, flags: { project: all } })).to.equal(null);
  });

  it('is the set of analysed hosts when the run was filtered, taking a url or a bare host', () => {
    expect([...analysedHosts({ discovery, flags: { project: ['https://north-a.example.org'] } })])
      .to.deep.equal(['north-a.example.org']);
    expect([...analysedHosts({ discovery, flags: { project: ['NORTH-A.example.org/'] } })])
      .to.deep.equal(['north-a.example.org']);
    const two = analysedHosts({ discovery, flags: { project: ['north-a.example.org', 'south-a.example.org'] } });
    expect([...two].sort()).to.deep.equal(['north-a.example.org', 'south-a.example.org']);
  });

  it('ignores a filter naming a host that was not discovered, rather than inventing one', () => {
    const hosts = analysedHosts({ discovery, flags: { project: ['nowhere.example.org', 'north-a.example.org'] } });
    expect([...hosts]).to.deep.equal(['north-a.example.org']);
  });
});

describe('rollup/scope scopeClassified', () => {
  const groupSizes = { 'North Programme': 2, 'South Programme': 1 };

  it('returns the record untouched when the run analysed everything', () => {
    const file = classifiedFile();
    expect(scopeClassified(file, null, { groupSizes })).to.equal(file);
  });

  it('narrows the instances, the groups, the housekeeping and the counts to the analysed hosts', () => {
    const scoped = scopeClassified(classifiedFile(), new Set(['north-a.example.org']), { groupSizes });
    expect(scoped.instances.map((i) => i.host)).to.deep.equal(['north-a.example.org']);
    expect(scoped.groups.map((g) => g.alert_key)).to.deep.equal(['North Programme/backlog']);
    expect(scoped.groups[0].firing).to.equal(1);
    expect(scoped.housekeeping).to.deep.equal([]);
    expect(scoped.counts).to.include({ firing: 1, housekeeping: 0, stale: 0 });
    // The record it was given is not mutated: the file on disk stays whole.
    expect(classifiedFile().instances).to.have.length(4);
  });

  it('keeps a housekeeping alert that is on an analysed host, out of the groups as always', () => {
    const scoped = scopeClassified(classifiedFile(), new Set(['south-a.example.org']), { groupSizes });
    expect(scoped.housekeeping.map((h) => h.host)).to.deep.equal(['south-a.example.org']);
    expect(scoped.counts).to.include({ firing: 1, housekeeping: 1 });
    expect(scoped.groups.map((g) => g.alert_key)).to.deep.equal(['South Programme/messaging']);
  });

  it('states an empty result for the analysed projects rather than reporting the others', () => {
    const quiet = { ...classifiedFile(), instances: [], housekeeping: [] };
    const scoped = scopeClassified(quiet, new Set(['north-a.example.org']), { groupSizes });
    expect(scoped.available).to.equal(true);
    expect(scoped.groups).to.deep.equal([]);
    expect(scoped.counts.firing).to.equal(0);
  });

  it('leaves an unavailable record alone: there is nothing to narrow', () => {
    const unavailable = { available: false, reason: 'HTTP 503', instances: [], groups: [], housekeeping: [] };
    expect(scopeClassified(unavailable, new Set(['north-a.example.org']), { groupSizes })).to.equal(unavailable);
  });

  it('drops a programme-wide pattern that the narrowed set no longer supports', () => {
    const wide = Array.from({ length: 4 }, (_, i) => classifiedInstance('delivery', `north-${i}.example.org`, {
      started_at: '2026-09-17T06:00:00Z',
    }));
    const file = { ...classifiedFile(), instances: wide, housekeeping: [] };
    const sizes = { Other: 4 };
    const whole = scopeClassified(file, null, { groupSizes: sizes });
    expect(whole).to.equal(file);
    const scoped = scopeClassified(file, new Set(['north-0.example.org']), { groupSizes: sizes });
    expect(scoped.groups[0].patterns).to.deep.equal([]);
    expect(alertsPolicy().stale_after_days).to.equal(14);
    expect(PROJECT_GROUPS).to.have.length(2);
  });
});

describe('rollup/scope onAnalysedHosts', () => {
  it('keeps every record when the run analysed everything, and filters by host otherwise', () => {
    const records = [{ host: 'north-a.example.org' }, { host: 'south-a.example.org' }, { host: null }];
    expect(onAnalysedHosts(records, null)).to.equal(records);
    expect(onAnalysedHosts(records, new Set(['north-a.example.org'])))
      .to.deep.equal([{ host: 'north-a.example.org' }]);
    // A record with no host belongs to the watchdog itself, not to a project the filter could name.
    expect(onAnalysedHosts(records, new Set(['nothing.example.org']))).to.deep.equal([]);
  });
});
