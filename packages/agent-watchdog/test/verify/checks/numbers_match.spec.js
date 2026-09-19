const { check } = require('../../../src/verify/checks/numbers_match');
const { baseContext, briefContext } = require('../helpers/context');

describe('verify/checks/numbers_match', () => {
  it('passes text whose numbers all match evidence or computed values', () => {
    const ctx = baseContext();
    ctx.items[0].why_now = 'Backlog is 912 against 300 yesterday, a 204.0% rise over 7h, above the 50% threshold.';
    expect(check(ctx).status).to.equal('pass');
  });

  it('accepts display rounding and thousands separators', () => {
    const ctx = baseContext();
    ctx.changes[0].current_value = 1234.5;
    ctx.items[0].evidence[0].value = 1234.5;
    ctx.items[0].why_now = 'Now at 1,230 after 1,234.5 samples';
    expect(check(ctx).status).to.equal('pass');
  });

  it('fails on a number that matches nothing computed', () => {
    const ctx = baseContext();
    ctx.items[0].why_now = 'Backlog is 999 today.';
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('999');
  });

  it('exempts numerals inside code spans but requires the span to be a known expression or metric', () => {
    const ctx = baseContext();
    ctx.items[0].suggested_check = 'Run `cht_sentinel_backlog_count` and `rate(cht_sentinel_backlog_count[5m])`.';
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('rate(cht_sentinel_backlog_count[5m])');
    ctx.items[0].suggested_check = 'Run `cht_sentinel_backlog_count{instance=~"$cht_instance"}` '
      + 'and `cht_sentinel_backlog_count`.';
    expect(check(ctx).status).to.equal('pass');
  });

  it('checks bullets against their item in brief mode', () => {
    expect(check(briefContext()).status).to.equal('pass');
    const ctx = briefContext();
    ctx.draft.bullets[0].text = 'backlog 5000 now';
    expect(check(ctx).status).to.equal('fail');
  });
});
