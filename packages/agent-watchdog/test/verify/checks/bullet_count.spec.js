const { check, MAX_BULLETS, MAX_PROJECT_LINES } = require('../../../src/verify/checks/bullet_count');
const { baseContext, briefContext } = require('../helpers/context');

const id = (n) => String(n).repeat(12);
const bullet = (n) => ({ item_id: id(n), text: 't' });
const entry = (n) => ({ lead_id: id(n), item_ids: [id(n)], host: `p${n}.example.org`, prefix: `p${n}: ` });

describe('verify/checks/bullet_count', () => {
  it('exposes two programme slots and three project lines as the limits (FR-010, FR-015, revision 28)', () => {
    expect(MAX_BULLETS).to.equal(2);
    expect(MAX_PROJECT_LINES).to.equal(3);
  });

  it('without a layout, passes up to two bullets and fails three', () => {
    const ctx = briefContext();
    ctx.draft.bullets = [1, 2].map(bullet);
    expect(check(ctx).status).to.equal('pass');
    ctx.draft.bullets.push(bullet(3));
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('3');
  });

  it('with a layout, requires one text per entry, body slots and thread replies alike, within the limits', () => {
    const ctx = briefContext();
    ctx.layout = {
      slots: [
        {
          slot: 1, kind: 'group', group: 'North Programme', entries: [1, 2, 3].map(entry), item_ids: [1, 2, 3].map(id),
        },
        { slot: 2, kind: 'item', group: 'Other', entries: [entry(4)], item_ids: [id(4)] },
      ],
      replies: [{ kind: 'programme', group: 'South Programme', entries: [5, 6].map(entry), item_ids: [5, 6].map(id) }],
      body_items: [1, 2, 3, 4].map(id),
      reply_items: [5, 6].map(id),
      thread_items: [],
    };
    ctx.draft.bullets = [1, 2, 3, 4, 5, 6].map(bullet);
    expect(check(ctx).status).to.equal('pass');

    ctx.draft.bullets = [1, 2, 3, 4].map(bullet);
    const fewer = check(ctx);
    expect(fewer.status).to.equal('fail');
    expect(fewer.reasons[0]).to.match(/4 bullets.*6 entries.*4 in the body, 2 in the thread/);

    ctx.draft.bullets = [1, 2, 3, 4, 5, 6].map(bullet);
    ctx.layout.slots[0].entries = [1, 2, 3, 7].map(entry);
    const crowded = check(ctx);
    expect(crowded.status).to.equal('fail');
    expect(crowded.reasons.some((r) => /4 project lines/.test(r))).to.equal(true);

    ctx.layout.slots = [1, 2, 3].map((n) => ({
      slot: n, kind: 'item', group: 'Other', entries: [entry(n)], item_ids: [id(n)],
    }));
    ctx.layout.body_items = [1, 2, 3].map(id);
    ctx.layout.reply_items = [];
    ctx.draft.bullets = [1, 2, 3].map(bullet);
    const wide = check(ctx);
    expect(wide.status).to.equal('fail');
    expect(wide.reasons.some((r) => /3 slots/.test(r))).to.equal(true);
  });

  it('is not applicable to findings', () => {
    expect(check(baseContext()).status).to.equal('pass');
  });
});
