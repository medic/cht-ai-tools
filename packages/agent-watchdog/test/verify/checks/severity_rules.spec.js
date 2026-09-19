const { check } = require('../../../src/verify/checks/severity_rules');
const { baseContext } = require('../helpers/context');

describe('verify/checks/severity_rules', () => {
  it('passes high severity backed by a high-floor candidate', () => {
    expect(check(baseContext()).status).to.equal('pass');
  });

  it('fails high severity without a qualifying candidate instead of downgrading', () => {
    const ctx = baseContext();
    ctx.items[0].candidate_ids = ['0123456789ab'];
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.match(/high/);
    expect(ctx.items[0].severity).to.equal('high');
  });

  it('fails a severity below the floor of a referenced candidate', () => {
    const ctx = baseContext();
    ctx.items[0].severity = 'low';
    expect(check(ctx).status).to.equal('fail');
  });

  it('passes low and medium items whose candidates have low floors', () => {
    const ctx = baseContext();
    ctx.items[0].severity = 'medium';
    ctx.items[0].candidate_ids = ['0123456789ab', 'cafebabecafe'];
    expect(check(ctx).status).to.equal('pass');
  });
});
