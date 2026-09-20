// Housekeeping and resolved lines (FR-080), written by code from the classified alerts and the episode record.
const { housekeepingNotice, resolvedNotice, clearedEpisodes } = require('../../src/rollup/notices');

describe('rollup/notices', () => {
  it('names stale alerts on hosts with no data once, with the hosts and what to do', () => {
    const housekeeping = Array.from({ length: 5 }, (_, i) => ({
      instance_id: `i${i}`, title: 'API Server Down', host: `dead-${i}.example.org`, started_at: '2026-07-08T00:00:00Z',
      days_firing: 72 + i,
    }));
    expect(housekeepingNotice(housekeeping)).to.equal(
      'Housekeeping: 5 alerts stale for 72+ days on 5 hosts with no data (dead-0.example.org, dead-1.example.org, '
      + 'dead-2.example.org, +2 more): remove them from the watchdog or silence the rules',
    );
    expect(housekeepingNotice([housekeeping[0]])).to.equal(
      'Housekeeping: 1 alert stale for 72+ days on 1 host with no data (dead-0.example.org): remove it from the '
      + 'watchdog or silence the rule',
    );
    expect(housekeepingNotice([])).to.equal(null);
  });

  it('lists episodes that were open and no longer fire, with how long they fired', () => {
    const events = [
      {
        event: 'opened', instance_id: 'a', title: 'Sentinel Backlog', host: 'north-a.example.org',
        started_at: '2026-09-15T06:00:00Z',
      },
      {
        event: 'opened', instance_id: 'b', title: 'API Server Down', host: 'north-b.example.org',
        started_at: '2026-09-17T18:00:00Z',
      },
      { event: 'opened', instance_id: 'c', title: 'DB Fragmentation', host: null, started_at: '2026-09-10T06:00:00Z' },
      { event: 'cleared', instance_id: 'c' },
    ];
    const cleared = clearedEpisodes({ events, firingIds: new Set(['b']), runStart: new Date('2026-09-18T06:00:00Z') });
    expect(cleared).to.deep.equal([
      { instance_id: 'a', title: 'Sentinel Backlog', host: 'north-a.example.org', days: 3 },
    ]);
    expect(resolvedNotice(cleared)).to.equal(
      'Resolved since the previous run: Sentinel Backlog on north-a.example.org (fired 3d)',
    );
    const many = Array.from({ length: 5 }, (_, i) => ({
      instance_id: `x${i}`, title: `Rule ${i}`, host: `h${i}.example.org`, days: 1,
    }));
    const threeNamed = new RegExp('^Resolved since the previous run: Rule 0 on h0.example.org \\(fired 1d\\); '
      + 'Rule 1 .*; Rule 2 .*, \\+2 more$');
    expect(resolvedNotice(many)).to.match(threeNamed);
    expect(resolvedNotice(many)).to.not.include('Rule 3');
    expect(resolvedNotice([])).to.equal(null);
  });
});
