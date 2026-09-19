const { check } = require('../../../src/verify/checks/bullet_length');
const { briefContext } = require('../helpers/context');

describe('verify/checks/bullet_length', () => {
  it('passes a bullet of at most two lines of at most 120 characters', () => {
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
});
