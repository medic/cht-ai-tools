const { check, MAX_BULLETS, MAX_CHILDREN } = require('../../../src/verify/checks/bullet_count');
const { baseContext, briefContext } = require('../helpers/context');

const id = (n) => String(n).repeat(12);
const bullet = (n) => ({ item_id: id(n), text: 't' });

describe('verify/checks/bullet_count', () => {
  it('exposes five bullets and eight sub-bullets as the limits (FR-010, FR-015)', () => {
    expect(MAX_BULLETS).to.equal(5);
    expect(MAX_CHILDREN).to.equal(8);
  });

  it('without a layout, passes up to five bullets and fails six', () => {
    const ctx = briefContext();
    ctx.draft.bullets = [1, 2, 3, 4, 5].map(bullet);
    expect(check(ctx).status).to.equal('pass');
    ctx.draft.bullets.push(bullet(6));
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('6');
  });

  it('with a layout, requires one bullet per body item and checks the slot and sub-bullet limits', () => {
    const ctx = briefContext();
    ctx.draft.bullets = [1, 2, 3, 4, 5, 6, 7].map(bullet);
    ctx.layout = {
      slots: [
        { slot: 1, kind: 'group', group: 'North Programme', item_ids: [1, 2, 3, 4, 5, 6].map(id), one_line: true },
        { slot: 2, kind: 'item', group: 'Other', item_ids: [id(7)], one_line: false },
      ],
      body_items: [1, 2, 3, 4, 5, 6, 7].map(id),
      thread_items: [],
      one_line: [1, 2, 3, 4, 5, 6].map(id),
    };
    expect(check(ctx).status).to.equal('pass');

    ctx.draft.bullets = [1, 2, 3].map(bullet);
    const fewer = check(ctx);
    expect(fewer.status).to.equal('fail');
    expect(fewer.reasons[0]).to.match(/3 bullets.*7 body items/);

    ctx.draft.bullets = [1, 2, 3, 4, 5, 6, 7].map(bullet);
    ctx.layout.slots[0].item_ids = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
    const crowded = check(ctx);
    expect(crowded.status).to.equal('fail');
    expect(crowded.reasons.some((r) => /9 sub-bullets/.test(r))).to.equal(true);

    ctx.layout.slots = [1, 2, 3, 4, 5, 6].map((n) => ({
      slot: n, kind: 'item', group: 'Other', item_ids: [id(n)], one_line: false,
    }));
    ctx.layout.body_items = [1, 2, 3, 4, 5, 6].map(id);
    ctx.draft.bullets = [1, 2, 3, 4, 5, 6].map(bullet);
    const wide = check(ctx);
    expect(wide.status).to.equal('fail');
    expect(wide.reasons.some((r) => /6 slots/.test(r))).to.equal(true);
  });

  it('is not applicable to findings', () => {
    expect(check(baseContext()).status).to.equal('pass');
  });
});
