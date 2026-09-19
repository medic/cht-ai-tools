const { check } = require('../../../src/verify/checks/thread_order');
const { briefContext, baseContext } = require('../helpers/context');

const id = (c) => c.repeat(12);

describe('verify/checks/thread_order', () => {
  const withItems = () => {
    const ctx = briefContext();
    ctx.items = ['a', 'b', 'c', 'd'].map((c) => ({ ...ctx.items[0], item_id: id(c) }));
    ctx.draft.bullets = ['a', 'b', 'c'].map((c) => ({ item_id: id(c), text: 't' }));
    ctx.draft.thread_order = ['a', 'b', 'c', 'd'].map(id);
    return ctx;
  };

  it('passes when every accepted item appears once and the bullets lead', () => {
    expect(check(withItems()).status).to.equal('pass');
  });

  it('fails a reordered lead, a missing item or a duplicate', () => {
    const ctx = withItems();
    ctx.draft.thread_order = ['a', 'c', 'b', 'd'].map(id);
    expect(check(ctx).status).to.equal('fail');
    ctx.draft.thread_order = ['a', 'b', 'c'].map(id);
    expect(check(ctx).status).to.equal('fail');
    ctx.draft.thread_order = ['a', 'b', 'c', 'd', 'd'].map(id);
    expect(check(ctx).status).to.equal('fail');
  });

  it('is not applicable to findings', () => {
    expect(check(baseContext()).status).to.equal('pass');
  });
});
