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

describe('verify/checks/numbers_match: the text the model was given (FR-016, revision 23)', () => {
  const { givenNumerals } = require('../../../src/verify/checks/numbers_match');

  it('accepts a numeral that appears in the session\'s prompts or tool results, in any of its forms', () => {
    const prompt = baseContext();
    prompt.givenText = ['"days_firing": 74, "title": "API Server Down"', 'rate(cht_conflict_count[24h]) * 60 * 60'];
    prompt.items[0].why_now = 'Backlog is 912; the alert has fired for 74 days (74d) over the 24h window.';
    expect(check(prompt).status).to.equal('pass');
    const tool = baseContext();
    tool.givenText = ['{"history": [{"run_id": "2026-09-01", "count": 41}]}'];
    tool.items[0].suggested_check = 'Compare with the 41 earlier occurrences.';
    expect(check(tool).status).to.equal('pass');
  });

  it('still refuses a numeral found in neither the given text nor the computed values', () => {
    const ctx = baseContext();
    ctx.givenText = ['nothing numeric was given'];
    ctx.items[0].why_now = 'Backlog is 912 after 48h of climbing.';
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons.join(' ')).to.include('48h');
  });

  it('collects bare values from given text: separators and unit letters dropped, dates ignored', () => {
    const given = givenNumerals(['{"value": 1,234, "since": "2026-09-01T06:00:00Z", "window": "[24h]", "pct": 12.5%}']);
    expect(given.has('1234')).to.equal(true);
    expect(given.has('24')).to.equal(true);
    expect(given.has('12.5')).to.equal(true);
    expect(given.has('2026')).to.equal(false);
    expect(givenNumerals([]).size).to.equal(0);
  });

  it('scopes a brief bullet to its own item\'s prompt entry and the run-wide counts, never another item\'s', () => {
    const ctx = briefContext();
    ctx.givenText = ['3 projects, 5 panels, 7 candidates'];
    ctx.itemTexts = new Map([
      [ctx.items[0].item_id, '{"rank": 1, "confidence": 0.85}'],
      ['other-item', '{"evidence": [{"value": 4321}]}'],
    ]);
    ctx.draft.bullets[0].text = 'cht.example.org backlog 912 vs 300, rank 1 of 7 candidates';
    expect(check(ctx).status).to.equal('pass');
    const borrowed = briefContext();
    borrowed.givenText = ctx.givenText;
    borrowed.itemTexts = ctx.itemTexts;
    borrowed.draft.bullets[0].text = 'cht.example.org backlog now 4321';
    expect(check(borrowed).status).to.equal('fail');
  });
});

describe('verify/checks/numbers_match: derived values (FR-016, revision 24)', () => {
  const { derivedValues } = require('../../../src/verify/checks/numbers_match');

  it('accepts a difference, a ratio and a percent change of two values the item may quote', () => {
    const jump = baseContext();
    jump.items[0].evidence = [
      { window: 'current', value: 845, unit: 'count' }, { window: 'previous_day', value: 818, unit: 'count' },
    ];
    jump.changes[0].current_value = 845;
    jump.changes[0].previous_day_value = 818;
    jump.items[0].why_now = 'Conflicts stepped from 818 to 845, a +27 jump in one day.';
    expect(check(jump).status).to.equal('pass');
    const ratio = baseContext();
    ratio.items[0].why_now = 'Backlog is 912 against 300 yesterday, roughly 3x, a 304% level.';
    expect(check(ratio).status).to.equal('pass');
    const fall = baseContext();
    fall.items[0].evidence = [
      { window: 'current', value: 132, unit: 'count' }, { window: 'previous_day', value: 300, unit: 'count' },
    ];
    fall.changes[0].current_value = 132;
    fall.items[0].why_now = 'The rate fell to 132 from 300, -56% in a day.';
    expect(check(fall).status).to.equal('pass');
  });

  it('still refuses a numeral that no pair of quotable values produces', () => {
    const ctx = baseContext();
    ctx.items[0].why_now = 'Backlog is 912 against 300 yesterday, so 4321 is expected.';
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons.join(' ')).to.include('4321');
  });

  it('derives from a bounded set and never divides by zero', () => {
    const allowed = [{ value: 845, unit: 'count' }, { value: 818, unit: 'count' }, { value: 0, unit: 'count' }];
    const derived = derivedValues(allowed);
    expect(derived.some((d) => d.value === 27 && d.unit === 'count')).to.equal(true);
    expect(derived.every((d) => Number.isFinite(d.value))).to.equal(true);
    const many = Array.from({ length: 200 }, (_, i) => ({ value: i + 1, unit: 'count' }));
    expect(derivedValues(many).length).to.be.at.most(60 * 59 * 3);
  });
});

describe('verify/checks/numbers_match: given numerals, roundings, units and ranges (FR-016, revision 25)', () => {
  const { check, rangeTokens } = require('../../../src/verify/checks/numbers_match');
  const { baseContext } = require('../helpers/context');

  it('accepts a numeral the model read in a tool result written as a JSON pair', () => {
    const ctx = baseContext();
    ctx.items[0].why_now = 'Backlog is 912 against 300 yesterday; the heap read 390778880 bytes at one point.';
    expect(check(ctx).status).to.equal('fail');
    ctx.givenText = ['{"values":[[1789538400,390778880],[1789624800,451162112]]}'];
    expect(check(ctx).status).to.equal('pass');
  });

  it('accepts a decimal or percentage that rounds a given numeral within its own decimals, nothing looser', () => {
    const ctx = baseContext();
    ctx.givenText = ['deviation_sigma 2.484518611472874, pct_change_vs_previous_day 32.656142204706285'];
    ctx.items[0].why_now = 'Backlog is 912 against 300 yesterday, 2.48 sigma up and +32.7% higher.';
    expect(check(ctx).status).to.equal('pass');
    const loose = baseContext();
    loose.givenText = ['deviation_sigma 2.484518611472874'];
    loose.items[0].why_now = 'Backlog is 912 against 300 yesterday, 2.2 sigma up.';
    const result = check(loose);
    expect(result.status).to.equal('fail');
    expect(result.reasons.join(' ')).to.include('2.2');
  });

  it('matches a percentage by magnitude when the direction is in the words', () => {
    const ctx = baseContext();
    ctx.changes[0].pct_change_vs_previous_day = -63.79150010454017;
    ctx.items[0].why_now = 'Backlog is 912 against 300 yesterday and fell 63.8% on the day.';
    expect(check(ctx).status).to.equal('pass');
  });

  it('reads days written as a word, and a _seconds metric in seconds', () => {
    const ctx = baseContext();
    ctx.items[0].metric = 'cht_date_uptime_seconds';
    ctx.changes[0].metric = 'cht_date_uptime_seconds';
    ctx.changes[0].current_value = 645829.189155882;
    ctx.items[0].evidence = [{ window: 'current', value: 645829.189155882, unit: 'count' }];
    ctx.items[0].why_now = 'The API has been up for 7.5 days without a restart.';
    expect(check(ctx).status).to.equal('pass');
    const hours = baseContext();
    hours.items[0].why_now = 'Backlog is 912 against 300 yesterday; the rise ran 7 hours.';
    expect(check(hours).status).to.equal('pass');
  });

  it('treats the range literal of a collected expression as an identifier when written bare', () => {
    const ctx = baseContext();
    ctx.discovery.dashboards[0].panels.push({
      id: 7, title: 'DB Conflicts Rate', metric: 'rate(cht_conflict_count[24h]) * 60 * 60 * 24',
      expr: 'rate(cht_conflict_count{instance=~"$cht_instance"}[24h]) * 60 * 60 * 24',
    });
    expect([...rangeTokens(ctx)]).to.include('24h');
    ctx.items[0].why_now = 'Backlog is 912 against 300 yesterday, with no restart in 24h.';
    expect(check(ctx).status).to.equal('pass');
    const unknown = baseContext();
    unknown.items[0].why_now = 'Backlog is 912 against 300 yesterday, with no restart in 36h.';
    expect(check(unknown).status).to.equal('fail');
  });
});

describe('verify/checks/numbers_match: evidence, headline and notice (FR-016, revision 33)', () => {
  const { check } = require('../../../src/verify/checks/numbers_match');
  const { baseContext, briefContext } = require('../helpers/context');

  it('refuses an evidence value that matches no computed value of the metric or collected sample of its window', () => {
    const ctx = baseContext();
    ctx.items[0].evidence.push({ window: 'current', value: 777, unit: 'count' });
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons).to.include(
      'items[0].evidence[2] value 777 for window current matches no computed or collected value',
    );
  });

  it('never lets an invented evidence value explain the same numeral in prose', () => {
    const ctx = baseContext();
    ctx.items[0].evidence.push({ window: 'current', value: 777, unit: 'count' });
    ctx.items[0].why_now = 'Backlog reached 777 overnight.';
    const result = check(ctx);
    expect(result.reasons.some((r) => r.startsWith('items[0].why_now contains 777'))).to.equal(true);
  });

  it('accepts evidence quoting a computed value, a collected sample of its own window, or a rounding of one', () => {
    const ctx = baseContext();
    ctx.windows[0].values = [[1758088800, 905], [1758092400, 912]];
    ctx.items[0].evidence = [
      { window: 'current', value: 912, unit: 'count' },
      { window: 'current', value: 905, unit: 'count', note: 'earlier sample' },
      { window: 'trailing_14d', value: 302, unit: 'count', note: 'mean' },
      { window: 'trailing_14d', value: 9.1, unit: 'count', note: 'stddev' },
      { window: 'previous_day', value: 300, unit: 'count' },
    ];
    expect(check(ctx).status).to.equal('pass');
    // A sample of another window is not evidence for this one.
    ctx.items[0].evidence.push({ window: 'previous_day', value: 905, unit: 'count' });
    expect(check(ctx).reasons).to.deep.equal([
      'items[0].evidence[5] value 905 for window previous_day matches no computed or collected value',
    ]);
  });

  it('checks the headline against every item\'s computed values and refuses a figure none holds', () => {
    const ok = briefContext();
    ok.draft.headline = 'Sentinel backlog 912 against 300 yesterday on one project';
    expect(check(ok).status).to.equal('pass');
    const bad = briefContext();
    bad.draft.headline = 'Sentinel backlog at 4321 on one project';
    const result = check(bad);
    expect(result.status).to.equal('fail');
    expect(result.reasons.some((r) => r.startsWith('headline contains 4321'))).to.equal(true);
  });

  it('checks the expected-load notice: what the run gave passes, a figure the model added does not', () => {
    const notice = 'Expected-load window active: month-end reporting, 2 days either side';
    const given = briefContext();
    given.givenText = [notice];
    given.draft.expected_load_notice = notice;
    expect(check(given).status).to.equal('pass');
    const added = briefContext();
    added.givenText = [notice];
    added.draft.expected_load_notice = 'Expected-load window active: month-end reporting, volumes up 40%';
    const result = check(added);
    expect(result.status).to.equal('fail');
    expect(result.reasons.some((r) => r.startsWith('expected_load_notice contains 40%'))).to.equal(true);
  });
});
