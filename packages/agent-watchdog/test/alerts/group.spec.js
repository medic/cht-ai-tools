// FR-066: Alert Groups per programme and category with counts, oldest start, highest importance and the members.
const { groupAlerts, alertKey, IMPORTANCE_ORDER } = require('../../src/alerts/group');
const { classified } = require('../helpers/alerts');

describe('alerts/group', () => {
  const instances = [
    classified('sentinel', 'north-a.example.org', { new: true }),
    classified('sentinel', 'north-b.example.org', { started_at: '2026-08-20T00:00:00Z' }),
    classified('outbound', 'north-a.example.org'),
    classified('apiDown', 'north-b.example.org', { started_at: '2026-09-18T05:00:00Z', new: true }),
    classified('fragmentation', 'north-c.example.org', { collected: { labels: { db: 'medic' } } }),
    classified('fragmentation', 'north-c.example.org', { collected: { labels: { db: 'sentinel' } } }),
    classified('delivery', 'south-a.example.org'),
    classified('watchdog', null),
    classified('sentinel', 'pending.example.org', { state: 'pending' }),
  ];

  it('orders importance critical, high, medium, low', () => {
    expect(IMPORTANCE_ORDER).to.deep.equal({ critical: 0, high: 1, medium: 2, low: 3 });
    expect(alertKey('North Programme', 'backlog')).to.equal('North Programme/backlog');
  });

  it('groups firing instances by programme and category with counts, oldest start and members', () => {
    const groups = groupAlerts(instances);
    expect(groups.map((g) => g.alert_key)).to.deep.equal([
      'North Programme/availability', 'North Programme/backlog', 'South Programme/messaging', 'Watchdog/uncategorised',
      'North Programme/database',
    ]);
    const backlog = groups.find((g) => g.alert_key === 'North Programme/backlog');
    expect(backlog).to.include({
      group: 'North Programme', category: 'backlog', importance: 'high', firing: 3, new: 1, stale: 1,
      oldest_started_at: '2026-08-20T00:00:00Z',
    });
    expect(backlog.rule_uids).to.deep.equal(['FzCrECYVk', 'KgP8PjY4k']);
    expect(backlog.titles).to.deep.equal(['Outbound Push Backlog', 'Sentinel Backlog']);
    expect(backlog.hosts).to.deep.equal(['north-a.example.org', 'north-b.example.org']);
    expect(backlog.instance_ids).to.have.length(3);
    expect(backlog.instances[0])
      .to.have.all.keys('instance_id', 'title', 'host', 'started_at', 'days_firing', 'stale', 'new');
    // Members are listed oldest first.
    expect(backlog.instances.map((i) => i.started_at)).to.deep.equal([
      '2026-08-20T00:00:00Z', '2026-09-17T20:00:00Z', '2026-09-17T20:00:00Z',
    ]);
    const database = groups.find((g) => g.alert_key === 'North Programme/database');
    expect(database).to.include({ firing: 2, importance: 'low' });
    expect(database.instance_ids).to.have.length(2);
    expect(groups.find((g) => g.group === 'Watchdog').hosts).to.deep.equal([]);
  });

  it('never groups a pending instance and returns no groups when nothing fires', () => {
    expect(groupAlerts(instances.filter((i) => i.state !== 'firing'))).to.deep.equal([]);
    expect(groupAlerts([])).to.deep.equal([]);
  });
});
