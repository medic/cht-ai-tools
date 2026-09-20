// Programme-wide alert patterns (FR-078): the same rule firing on most of a programme's projects within two days is
// one event, named once, not one line per project.
const { detectPatterns, PATTERN_MIN_HOSTS, PATTERN_MIN_SHARE } = require('../../src/alerts/patterns');
const { classified } = require('../helpers/alerts');

const hosts = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}-${i}.example.org`);

describe('alerts/patterns', () => {
  it('finds a rule firing on at least three hosts and half a programme within two days', () => {
    const instances = [
      ...hosts(4, 'south').map((h, i) => classified('delivery', h, {
        started_at: `2026-09-1${6 + (i % 3)}T00:00:00Z`,
      })),
      classified('sentinel', 'north-a.example.org'),
    ];
    const patterns = detectPatterns({ instances, groupSizes: { 'South Programme': 6, 'North Programme': 3 } });
    expect(patterns).to.have.length(1);
    expect(patterns[0]).to.include({
      group: 'South Programme', category: 'messaging', title: 'Message Delivery Rate', count: 4, of: 6,
      since_min: '2026-09-16', since_max: '2026-09-18',
    });
    expect(patterns[0].hosts).to.deep.equal(hosts(4, 'south').sort());
    expect(patterns[0].instance_ids).to.have.length(4);
    expect(PATTERN_MIN_HOSTS).to.equal(3);
    expect(PATTERN_MIN_SHARE).to.equal(0.5);
  });

  it('needs the share, the count and the window, and ignores housekeeping and pending instances', () => {
    const spread = hosts(4, 'south').map((h, i) => classified('delivery', h, {
      started_at: i === 0 ? '2026-09-10T00:00:00Z' : '2026-09-17T00:00:00Z',
    }));
    expect(detectPatterns({ instances: spread, groupSizes: { 'South Programme': 6 } }), 'seven days apart')
      .to.deep.equal([]);
    const few = hosts(2, 'south').map((h) => classified('delivery', h));
    expect(detectPatterns({ instances: few, groupSizes: { 'South Programme': 2 } }), 'two hosts').to.deep.equal([]);
    const minority = hosts(3, 'south').map((h) => classified('delivery', h));
    expect(detectPatterns({ instances: minority, groupSizes: { 'South Programme': 10 } }), 'under half')
      .to.deep.equal([]);
    expect(detectPatterns({ instances: minority, groupSizes: {} }), 'unknown programme size: the hosts seen')
      .to.have.length(1);
    const kept = hosts(3, 'south').map((h) => classified('delivery', h, { housekeeping: true }));
    expect(detectPatterns({ instances: kept, groupSizes: {} })).to.deep.equal([]);
  });
});
