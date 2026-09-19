const { check } = require('../../../src/verify/checks/pattern_cards_known');
const { baseContext } = require('../helpers/context');

describe('verify/checks/pattern_cards_known', () => {
  it('passes null and known card ids and fails unknown ids', () => {
    expect(check(baseContext()).status).to.equal('pass');
    const ctx = baseContext();
    ctx.items[0].pattern_card = 'sentinel-stall';
    expect(check(ctx).status).to.equal('pass');
    ctx.items[0].pattern_card = 'invented-card';
    expect(check(ctx).reasons[0]).to.include('invented-card');
  });
});
