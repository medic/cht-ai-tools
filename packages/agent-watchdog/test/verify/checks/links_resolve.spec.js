const { check } = require('../../../src/verify/checks/links_resolve');
const { baseContext } = require('../helpers/context');

describe('verify/checks/links_resolve', () => {
  it('passes with a reason when no resolution was performed', () => {
    const result = check(baseContext());
    expect(result.status).to.equal('pass');
    expect(result.reasons[0]).to.equal('not resolved (offline)');
  });

  it('fails when any resolved link is not ok', () => {
    const ctx = baseContext();
    ctx.linkResults = new Map([
      ['https://docs.communityhealthtoolkit.org/hosting/monitoring/', { ok: true, status: 200, reason: 'ok' }],
      ['https://watchdog.example.org/d/oa2OfL-Vk/x', { ok: false, status: null, reason: 'unknown dashboard' }],
    ]);
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('unknown dashboard');
  });

  it('passes when every resolved link is ok', () => {
    const ctx = baseContext();
    ctx.linkResults = new Map([['https://a.example.org', { ok: true, status: 200, reason: 'ok' }]]);
    expect(check(ctx).status).to.equal('pass');
  });
});
