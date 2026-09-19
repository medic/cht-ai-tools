const { check } = require('../../../src/verify/checks/dates_match');
const { baseContext, briefContext } = require('../helpers/context');

describe('verify/checks/dates_match', () => {
  it('passes when evidence and dashboard windows fall inside the collected windows', () => {
    const ctx = baseContext();
    ctx.items[0].evidence[0].start = '2026-09-17T06:00:00Z';
    ctx.items[0].evidence[0].end = '2026-09-18T06:00:00Z';
    expect(check(ctx).status).to.equal('pass');
  });

  it('fails when an evidence window or the dashboard range lies outside the run', () => {
    const ctx = baseContext();
    ctx.items[0].evidence[0].start = '2026-08-01T00:00:00Z';
    ctx.items[0].evidence[0].end = '2026-08-02T00:00:00Z';
    expect(check(ctx).status).to.equal('fail');
    const ctx2 = baseContext();
    ctx2.items[0].dashboard_ref.to = '2026-09-30T00:00:00Z';
    expect(check(ctx2).status).to.equal('fail');
  });

  it('fails when the metric has no collected windows and is not applicable in brief mode', () => {
    const ctx = baseContext();
    ctx.windows = [];
    expect(check(ctx).status).to.equal('fail');
    expect(check(briefContext()).status).to.equal('pass');
  });
});
