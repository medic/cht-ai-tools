const { check, stripRunIdentifiers, WINDOW_NAME_TOKENS } = require('../../../src/verify/checks/numbers_match');
const { extractNumbers } = require('../../../src/verify/format');
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

  it('accepts the run\'s own window names, which are identifiers and not figures (revision 18)', () => {
    const ctx = baseContext();
    ctx.items[0].why_now = 'Backlog is 912, far above the trailing_14d baseline.';
    expect(check(ctx).status).to.equal('pass');
    const short = baseContext();
    short.items[0].why_now = 'Backlog is 912, far above the 14d trailing mean.';
    expect(check(short).status).to.equal('pass');
    // A figure that merely ends in the same letter is still checked.
    const other = baseContext();
    other.items[0].why_now = 'Backlog is 912 after 9d of climbing.';
    expect(check(other).reasons.join(' ')).to.include('9d');
  });

  it('accepts the numeral of a window name on its own: "14 days" and "14-day" name the window (revision 22)', () => {
    const days = baseContext();
    days.items[0].why_now = 'Backlog is 912, far above the mean over the trailing 14 days.';
    expect(check(days).status).to.equal('pass');
    const hyphen = baseContext();
    hyphen.items[0].why_now = 'Backlog is 912 against a 14-day baseline.';
    expect(check(hyphen).status).to.equal('pass');
    expect(WINDOW_NAME_TOKENS.has('14')).to.equal(true);
    expect(WINDOW_NAME_TOKENS.has('14d')).to.equal(true);
  });

  it('accepts the numerals inside a collected expression written out in prose (revision 22)', () => {
    const ctx = baseContext();
    ctx.discovery.dashboards[0].panels.push({
      id: 7, title: 'Backlog Rate', expr: 'rate(cht_sentinel_backlog_count[24h]) * 60 * 60 * 24',
      metric: 'cht_sentinel_backlog_count',
    });
    ctx.items[0].why_now = 'Backlog is 912 and rate(cht_sentinel_backlog_count[24h]) * 60 * 60 * 24 rose with it.';
    expect(check(ctx).status).to.equal('pass');
    const stripped = stripRunIdentifiers(ctx.items[0].why_now, ctx);
    expect(extractNumbers(stripped)).to.deep.equal(['912']);
    // Without that panel the same numerals are figures the model must justify.
    const bare = baseContext();
    bare.items[0].why_now = 'Backlog is 912 and rate(cht_sentinel_backlog_count[24h]) * 60 * 60 * 24 rose with it.';
    expect(check(bare).status).to.equal('fail');
  });

  it('accepts a collected panel id named in prose and still rejects one that was not collected (revision 22)', () => {
    const ctx = baseContext();
    ctx.items[0].suggested_check = 'Open panel 3 on the overview and compare with panel 2.';
    expect(check(ctx).status).to.equal('pass');
    expect(extractNumbers(stripRunIdentifiers('Open panel 3, panel-2 and panel 99.', ctx))).to.deep.equal(['99']);
    const unknown = baseContext();
    unknown.items[0].suggested_check = 'Open panel 99 on the overview.';
    const result = check(unknown);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('99');
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
