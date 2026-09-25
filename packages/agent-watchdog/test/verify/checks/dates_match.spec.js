const { check } = require('../../../src/verify/checks/dates_match');
const { baseContext, briefContext } = require('../helpers/context');

// Revision 33: the check reads the dates the model writes, not evidence fields the findings schema never admitted.
describe('verify/checks/dates_match', () => {
  it('passes prose dates inside the metric\'s collected windows, in ISO, day-month and month-day forms', () => {
    const ctx = baseContext();
    ctx.items[0].why_now = 'Backlog has climbed since 2026-09-10, steeply from 15 September (Sept 16th too).';
    ctx.items[0].suggested_check = 'Compare with September 8, 2026 before the rise.';
    expect(check(ctx)).to.deep.equal({ name: 'dates_match', status: 'pass', reasons: [] });
  });

  it('refuses a date outside the run\'s windows wherever the model wrote it, naming the field', () => {
    const why = baseContext();
    why.items[0].why_now = 'Backlog rising since 2026-08-01.';
    expect(check(why).reasons).to.deep.equal([
      'items[0].why_now names 2026-08-01, outside the run\'s windows (2026-09-04 to 2026-09-18)',
    ]);
    const suggested = baseContext();
    suggested.items[0].suggested_check = 'Look at the deploy of 25 December.';
    // A yearless date is read in the year nearest the run (revision 36): the coming December here.
    expect(check(suggested).reasons[0]).to.match(/^items\[0\]\.suggested_check names 2026-12-25/);
    const note = baseContext();
    note.items[0].evidence[0].note = 'peak on 2026-01-05';
    expect(check(note).reasons[0]).to.match(/^items\[0\]\.evidence\[0\]\.note names 2026-01-05/);
  });

  it('exempts a date the model was given, such as the horizon the notice names', () => {
    const ctx = baseContext();
    ctx.givenText = ['Expected-load window active until 2026-10-02'];
    ctx.items[0].why_now = 'Expected to stay high until 2026-10-02.';
    expect(check(ctx).status).to.equal('pass');
  });

  it('still holds the dashboard range to the windows and fails a metric with no collected windows', () => {
    const ref = baseContext();
    ref.items[0].dashboard_ref.to = '2026-09-30T00:00:00Z';
    expect(check(ref).status).to.equal('fail');
    const none = baseContext();
    none.windows = [];
    expect(check(none).reasons[0]).to.include('has no collected windows');
  });

  it('ignores evidence start and end fields, which the findings schema never admits', () => {
    const ctx = baseContext();
    ctx.items[0].evidence[0].start = '2026-08-01T00:00:00Z';
    ctx.items[0].evidence[0].end = '2026-08-02T00:00:00Z';
    expect(check(ctx).status).to.equal('pass');
  });

  it('checks a brief\'s headline, bullets and notice against the run\'s span from the discovery\'s run start', () => {
    const ctx = briefContext();
    // The brief gate carries no windows (gate.js passes none); the span comes from the discovery's run start.
    ctx.windows = [];
    ctx.discovery.run_start = '2026-09-18T06:00:00Z';
    ctx.draft.bullets[0].text = 'cht.example.org sentinel backlog 912 vs 300, climbing since 2026-09-12';
    expect(check(ctx).status).to.equal('pass');
    ctx.draft.headline = 'Backlogs up since 2026-01-01';
    expect(check(ctx).reasons).to.deep.equal([
      'headline names 2026-01-01, outside the run\'s windows (2026-08-29 to 2026-09-18)',
    ]);
    ctx.draft.headline = 'One project needs a look';
    ctx.draft.expected_load_notice = 'Expected until 2026-10-02';
    expect(check(ctx).status).to.equal('fail');
    ctx.givenText = ['Expected-load window active until 2026-10-02'];
    expect(check(ctx).status).to.equal('pass');
  });

  it('passes a brief with no windows and no run start to check against, saying so', () => {
    const ctx = briefContext();
    ctx.windows = [];
    expect(check(ctx)).to.deep.equal({
      name: 'dates_match', status: 'pass', reasons: ['no run start to check dates against'],
    });
  });
});

describe('verify/checks/dates_match: what the run gave is exempt in every form (revision 36)', () => {
  it('accepts a yearless restatement of a horizon the run gave as an ISO date, and a timestamp it gave', () => {
    const horizon = baseContext();
    horizon.givenText = ['{"horizon": "2026-10-01", "expected_max": 500}'];
    horizon.items[0].why_now = 'Above the 500 the team expected until 1 October.';
    expect(check(horizon).status).to.equal('pass');
    const stamped = baseContext();
    stamped.givenText = ['{"started_at": "2026-08-01T12:00:00.000Z", "title": "Disk"}'];
    stamped.items[0].why_now = 'The disk alert has fired since 2026-08-01, well before this window.';
    expect(check(stamped).status).to.equal('pass');
    const written = baseContext();
    written.items[0].why_now = 'Rising since 2026-07-01T00:00Z.';
    expect(check(written).reasons[0]).to.match(/names 2026-07-01/);
  });

  it('reads the system prompt as given for dates in a finding, and the feedback and memory in a brief', () => {
    const finding = baseContext();
    finding.givenDateText = ['# Run context\n- campaign: Measles campaign until 2026-10-10'];
    finding.items[0].why_now = 'Volumes expected until 2026-10-10 (campaign).';
    expect(check(finding).status).to.equal('pass');
    const brief = briefContext();
    brief.windows = [];
    brief.discovery.run_start = '2026-09-18T06:00:00Z';
    brief.givenDateText = ['"horizon": "2026-10-15"', 'alpha spikes at month end (until 2026-11-02)'];
    brief.draft.bullets[0].text = 'cht.example.org sentinel backlog 912 vs 300, expected until 15 October';
    brief.draft.headline = 'Two projects, one expected until 2026-11-02';
    expect(check(brief).status).to.equal('pass');
  });

  it('puts the previous cycle into the brief\'s span when an expected-load window with one is active', () => {
    const brief = briefContext();
    brief.windows = [];
    brief.discovery.run_start = '2026-09-30T06:00:00Z';
    brief.draft.headline = 'Volumes up on the same point last cycle (30 August)';
    expect(check(brief).status).to.equal('fail');
    brief.activeWindow = { id: 'month-end', kind: 'month_end', cycle_days: 30 };
    expect(check(brief).status).to.equal('pass');
  });
});
