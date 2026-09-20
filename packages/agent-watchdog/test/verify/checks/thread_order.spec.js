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

  it('with a layout, rejects bullets whose item ids differ from the body items (FR-069)', () => {
    const ctx = withItems();
    ctx.layout = {
      slots: [{ slot: 1, kind: 'group', group: 'MoH Nepal', item_ids: ['a', 'b', 'c'].map(id), one_line: true }],
      body_items: ['a', 'b', 'c'].map(id), thread_items: [id('d')], one_line: ['a', 'b', 'c'].map(id),
    };
    expect(check(ctx).status).to.equal('pass');
    ctx.draft.bullets = ['a', 'b', 'd'].map((c) => ({ item_id: id(c), text: 't' }));
    ctx.draft.thread_order = ['a', 'b', 'd', 'c'].map(id);
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    const mismatch = result.reasons.find((r) => r.includes('layout'));
    expect(mismatch).to.include(id('c')).and.include(id('d'));
  });

  it('is not applicable to findings', () => {
    expect(check(baseContext()).status).to.equal('pass');
  });
});
