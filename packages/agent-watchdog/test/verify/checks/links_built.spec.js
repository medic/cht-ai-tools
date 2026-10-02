const { check } = require('../../../src/verify/checks/links_built');
const { baseContext } = require('../helpers/context');

describe('verify/checks/links_built', () => {
  it('passes a dashboard reference to a known dashboard and panel', () => {
    expect(check(baseContext()).status).to.equal('pass');
  });

  it('fails an unknown dashboard uid, an unknown panel id or a non-ISO timestamp', () => {
    const ctx = baseContext();
    ctx.items[0].dashboard_ref.dashboard_uid = 'nope';
    expect(check(ctx).status).to.equal('fail');
    const ctx2 = baseContext();
    ctx2.items[0].dashboard_ref.panel_id = 99;
    expect(check(ctx2).status).to.equal('fail');
    const ctx3 = baseContext();
    ctx3.items[0].dashboard_ref.from = 'yesterday';
    expect(check(ctx3).status).to.equal('fail');
  });

  it('fails when from is not before to', () => {
    const ctx = baseContext();
    ctx.items[0].dashboard_ref.from = ctx.items[0].dashboard_ref.to;
    expect(check(ctx).status).to.equal('fail');
  });
});
