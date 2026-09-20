const { isoWeekOf, weekRange, WEEK_PATTERN } = require('../../src/calibration/week');

describe('calibration/week', () => {
  it('names the ISO week of a date, including the year boundaries', () => {
    expect(isoWeekOf(new Date('2026-09-18T12:00:00Z'))).to.equal('2026-W38');
    expect(isoWeekOf(new Date('2026-01-01T00:00:00Z'))).to.equal('2026-W01');
    expect(isoWeekOf(new Date('2027-01-01T00:00:00Z'))).to.equal('2026-W53');
    expect(isoWeekOf(new Date('2024-12-30T00:00:00Z'))).to.equal('2025-W01');
    expect(isoWeekOf('2026-09-20')).to.equal('2026-W38');
  });

  it('returns the Monday and Sunday of a week', () => {
    expect(weekRange('2026-W38')).to.deep.equal({ monday: '2026-09-14', sunday: '2026-09-20' });
    expect(weekRange('2026-W01')).to.deep.equal({ monday: '2025-12-29', sunday: '2026-01-04' });
    expect(weekRange('2026-W53')).to.deep.equal({ monday: '2026-12-28', sunday: '2027-01-03' });
  });

  it('rejects malformed and non-existent weeks with a RangeError', () => {
    for (const bad of ['2026-38', '2026-W0', '2026-W54', '2025-W53', 'week', null, undefined, '2026-W00']) {
      expect(() => weekRange(bad), String(bad)).to.throw(RangeError);
    }
  });

  it('exposes the week pattern', () => {
    expect(WEEK_PATTERN.test('2026-W38')).to.equal(true);
    expect(WEEK_PATTERN.test('2026-W3')).to.equal(false);
  });
});
