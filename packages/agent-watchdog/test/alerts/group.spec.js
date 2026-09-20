// FR-066: Alert Groups per programme and category with counts, oldest start, highest importance and the members.
const { groupAlerts, alertKey, IMPORTANCE_ORDER } = require('../../src/alerts/group');
const { classified } = require('../helpers/alerts');

describe('alerts/group', () => {
  const instances = [
    classified('sentinel', 'nepal-a.example.org', { new: true }),
    classified('sentinel', 'nepal-b.example.org', { started_at: '2026-08-20T00:00:00Z' }),
    classified('outbound', 'nepal-a.example.org'),
    classified('apiDown', 'nepal-b.example.org', { started_at: '2026-09-18T05:00:00Z', new: true }),
    classified('fragmentation', 'nepal-c.example.org', { collected: { labels: { db: 'medic' } } }),
    classified('fragmentation', 'nepal-c.example.org', { collected: { labels: { db: 'sentinel' } } }),
    classified('delivery', 'echis-a.example.org'),
    classified('watchdog', null),
    classified('sentinel', 'pending.example.org', { state: 'pending' }),
  ];

  it('orders importance critical, high, medium, low', () => {
    expect(IMPORTANCE_ORDER).to.deep.equal({ critical: 0, high: 1, medium: 2, low: 3 });
    expect(alertKey('MoH Nepal', 'backlog')).to.equal('MoH Nepal/backlog');
  });

  it('groups firing instances by programme and category with counts, oldest start and members', () => {
    const groups = groupAlerts(instances);
    expect(groups.map((g) => g.alert_key)).to.deep.equal([
      'MoH Nepal/availability', 'MoH Nepal/backlog', 'eCHIS Kenya/messaging', 'Watchdog/uncategorised',
      'MoH Nepal/database',
    ]);
    const backlog = groups.find((g) => g.alert_key === 'MoH Nepal/backlog');
    expect(backlog).to.include({
      group: 'MoH Nepal', category: 'backlog', importance: 'high', firing: 3, new: 1, stale: 1,
      oldest_started_at: '2026-08-20T00:00:00Z',
    });
    expect(backlog.rule_uids).to.deep.equal(['FzCrECYVk', 'KgP8PjY4k']);
    expect(backlog.titles).to.deep.equal(['Outbound Push Backlog', 'Sentinel Backlog']);
    expect(backlog.hosts).to.deep.equal(['nepal-a.example.org', 'nepal-b.example.org']);
    expect(backlog.instance_ids).to.have.length(3);
    expect(backlog.instances[0])
      .to.have.all.keys('instance_id', 'title', 'host', 'started_at', 'days_firing', 'stale', 'new');
    // Members are listed oldest first.
    expect(backlog.instances.map((i) => i.started_at)).to.deep.equal([
      '2026-08-20T00:00:00Z', '2026-09-17T20:00:00Z', '2026-09-17T20:00:00Z',
    ]);
    const database = groups.find((g) => g.alert_key === 'MoH Nepal/database');
    expect(database).to.include({ firing: 2, importance: 'low' });
    expect(database.instance_ids).to.have.length(2);
    expect(groups.find((g) => g.group === 'Watchdog').hosts).to.deep.equal([]);
  });

  it('never groups a pending instance and returns no groups when nothing fires', () => {
    expect(groupAlerts(instances.filter((i) => i.state !== 'firing'))).to.deep.equal([]);
    expect(groupAlerts([])).to.deep.equal([]);
  });
});
