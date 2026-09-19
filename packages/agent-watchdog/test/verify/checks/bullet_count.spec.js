const { check } = require('../../../src/verify/checks/bullet_count');
const { baseContext, briefContext } = require('../helpers/context');

describe('verify/checks/bullet_count', () => {
  it('passes up to three bullets and fails four', () => {
    const ctx = briefContext();
    const bullet = (n) => ({ item_id: String(n).repeat(12), text: 't' });
    ctx.draft.bullets = [bullet(1), bullet(2), bullet(3)];
    expect(check(ctx).status).to.equal('pass');
    ctx.draft.bullets.push(bullet(4));
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('4');
  });

  it('is not applicable to findings', () => {
    expect(check(baseContext()).status).to.equal('pass');
  });
});
