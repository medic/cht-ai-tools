const { activeWindow, dateInZone } = require('../../src/analyze/calendar');

const monthEnd = {
  id: 'month-end', kind: 'month_end', days_before: 2, days_after: 2, timezone: 'Africa/Nairobi',
  note: 'n', cycle_days: 30,
};
const sync = {
  id: 'sync', kind: 'dates', start: '2026-10-05', end: '2026-10-09', timezone: 'Africa/Kampala',
  note: 'n', cycle_days: 90,
};
const weekly = { id: 'monday', kind: 'weekly', weekday: 1, timezone: 'UTC', note: 'n', cycle_days: 7 };
const project = { expected_load_windows: [] };

describe('analyze/calendar', () => {
  it('reads the calendar date in a timezone', () => {
    const lateEvening = new Date('2026-09-30T22:00:00Z');
    expect(dateInZone(lateEvening, 'Africa/Nairobi')).to.deep.equal({ year: 2026, month: 10, day: 1, weekday: 4 });
    expect(dateInZone(lateEvening, 'UTC')).to.deep.equal({ year: 2026, month: 9, day: 30, weekday: 3 });
  });

  it('detects month-end windows on both sides of the boundary in the window timezone', () => {
    expect(activeWindow([monthEnd], project, new Date('2026-09-29T06:00:00Z')).id).to.equal('month-end');
    expect(activeWindow([monthEnd], project, new Date('2026-09-30T22:00:00Z')).id).to.equal('month-end');
    expect(activeWindow([monthEnd], project, new Date('2026-10-02T06:00:00Z')).id).to.equal('month-end');
    expect(activeWindow([monthEnd], project, new Date('2026-10-03T06:00:00Z'))).to.equal(null);
    expect(activeWindow([monthEnd], project, new Date('2026-09-28T06:00:00Z'))).to.equal(null);
  });

  it('detects date ranges inclusively and weekly windows by weekday', () => {
    expect(activeWindow([sync], project, new Date('2026-10-05T06:00:00Z')).id).to.equal('sync');
    expect(activeWindow([sync], project, new Date('2026-10-09T06:00:00Z')).id).to.equal('sync');
    expect(activeWindow([sync], project, new Date('2026-10-10T06:00:00Z'))).to.equal(null);
    expect(activeWindow([weekly], project, new Date('2026-09-21T06:00:00Z')).id).to.equal('monday');
    expect(activeWindow([weekly], project, new Date('2026-09-22T06:00:00Z'))).to.equal(null);
  });

  it('prefers a project window over a default and returns null without windows', () => {
    const projectWindow = { ...sync, id: 'project-sync' };
    const configured = { expected_load_windows: [projectWindow] };
    expect(activeWindow([sync], configured, new Date('2026-10-06T06:00:00Z')).id).to.equal('project-sync');
    expect(activeWindow([], project, new Date('2026-10-06T06:00:00Z'))).to.equal(null);
  });
});
