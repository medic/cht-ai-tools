const { check, MAX_LINES, MAX_LINE_CHARS } = require('../../../src/verify/checks/bullet_length');
const { briefContext } = require('../helpers/context');

describe('verify/checks/bullet_length', () => {
  it('passes a bullet of at most two lines of at most 120 characters', () => {
    expect([MAX_LINES, MAX_LINE_CHARS]).to.deep.equal([2, 120]);
    const ctx = briefContext();
    ctx.draft.bullets[0].text = `${'a'.repeat(120)}\n${'b'.repeat(120)}`;
    expect(check(ctx).status).to.equal('pass');
  });

  it('fails three lines, a 121-character line, or a URL in the text', () => {
    const ctx = briefContext();
    ctx.draft.bullets[0].text = 'one\ntwo\nthree';
    expect(check(ctx).status).to.equal('fail');
    ctx.draft.bullets[0].text = 'x'.repeat(121);
    expect(check(ctx).status).to.equal('fail');
    ctx.draft.bullets[0].text = 'see https://watchdog.example.org/d/x';
    expect(check(ctx).reasons[0]).to.include('URL');
  });

  it('lets every entry take two lines, and holds the headline to two lines of 120 (revision 28)', () => {
    const ctx = briefContext();
    ctx.layout = {
      slots: [], replies: [], entries: {}, body_items: ['a1b2c3d4e5f6'], reply_items: [], thread_items: [],
    };
    ctx.draft.bullets[0].text = 'first line\nsecond line';
    expect(check(ctx).status).to.equal('pass');
    ctx.draft.headline = `${'h'.repeat(120)}\n${'i'.repeat(120)}`;
    expect(check(ctx).status).to.equal('pass');
    ctx.draft.headline = 'h'.repeat(121);
    expect(check(ctx).reasons[0]).to.match(/^headline line 1 has 121 characters/);
    ctx.draft.headline = 'one\ntwo\nthree';
    expect(check(ctx).reasons[0]).to.match(/^headline has 3 lines/);
  });
});

describe('verify/checks/bullet_length: the budget after the project code writes (FR-069, revision 26)', () => {
  const { check } = require('../../../src/verify/checks/bullet_length');
  const { briefContext } = require('../helpers/context');
  const withLayout = (ctx, kind) => {
    ctx.items = [{ ...ctx.items[0], item_id: 'a1b2c3d4e5f6', project_url: 'https://north-a.example.org' }];
    const prefix = kind === 'group' ? 'north-a: ' : 'north-a.example.org: ';
    ctx.layout = {
      slots: [{
        slot: 1, kind, group: 'North Programme', item_ids: ['a1b2c3d4e5f6'],
        entries: [{ lead_id: 'a1b2c3d4e5f6', item_ids: ['a1b2c3d4e5f6'], host: 'north-a.example.org', prefix }],
      }],
      replies: [],
      entries: {
        a1b2c3d4e5f6: {
          item_ids: ['a1b2c3d4e5f6'], host: 'north-a.example.org', prefix, budget: 120 - prefix.length, where: 'body',
          group: 'North Programme',
        },
      },
      body_items: ['a1b2c3d4e5f6'], reply_items: [], thread_items: [],
    };
    return ctx;
  };

  it('gives a sub-bullet 120 characters minus its short-host prefix and names the prefix in the reason', () => {
    const ctx = withLayout(briefContext(), 'group');
    ctx.draft.bullets[0].text = 'x'.repeat(111);
    expect(check(ctx).status).to.equal('pass');
    ctx.draft.bullets[0].text = 'x'.repeat(112);
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('at most 111 allowed').and.include('"north-a: "');
  });

  it('gives an item bullet\'s first line 120 minus its full-host prefix and leaves the second line at 120', () => {
    const ctx = withLayout(briefContext(), 'item');
    ctx.draft.bullets[0].text = `${'x'.repeat(99)}\n${'y'.repeat(120)}`;
    expect(check(ctx).status).to.equal('pass');
    ctx.draft.bullets[0].text = `${'x'.repeat(100)}\n${'y'.repeat(120)}`;
    expect(check(ctx).reasons[0]).to.include('line 1').and.include('at most 99 allowed');
  });

  it('keeps the old limits when the gate has no layout or no items', () => {
    const ctx = briefContext();
    ctx.draft.bullets[0].text = 'x'.repeat(120);
    expect(check(ctx).status).to.equal('pass');
  });
});
