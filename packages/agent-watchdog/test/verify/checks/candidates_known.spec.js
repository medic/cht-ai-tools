const { check } = require('../../../src/verify/checks/candidates_known');
const { baseContext } = require('../helpers/context');

describe('verify/checks/candidates_known', () => {
  it('passes when every candidate id exists', () => {
    expect(check(baseContext()).status).to.equal('pass');
  });

  it('fails for an unknown candidate id and for an empty list', () => {
    const ctx = baseContext();
    ctx.items[0].candidate_ids = ['0123456789ab', 'deadbeefdead'];
    expect(check(ctx).reasons[0]).to.include('deadbeefdead');
    ctx.items[0].candidate_ids = [];
    expect(check(ctx).status).to.equal('fail');
  });
});
