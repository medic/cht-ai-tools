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

  it('requires a single line from an item the layout marks as a sub-bullet (FR-015, FR-069)', () => {
    const ctx = briefContext();
    ctx.layout = { slots: [], body_items: ['a1b2c3d4e5f6'], thread_items: [], one_line: ['a1b2c3d4e5f6'] };
    ctx.draft.bullets[0].text = 'one line only';
    expect(check(ctx).status).to.equal('pass');
    ctx.draft.bullets[0].text = 'first line\nsecond line';
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.match(/sub-bullet.*one line/);
    // An item that owns its slot may still take two lines.
    ctx.layout.one_line = [];
    expect(check(ctx).status).to.equal('pass');
  });
});
