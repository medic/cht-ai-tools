const { check, baseMetricName } = require('../../../src/verify/checks/metrics_known');
const { baseContext } = require('../helpers/context');

describe('verify/checks/metrics_known', () => {
  it('passes for a collected metric key and for a base metric name', () => {
    expect(check(baseContext()).status).to.equal('pass');
    const ctx = baseContext();
    ctx.items[0].metric = 'increase(cht_sentinel_backlog_count[1d])';
    expect(check(ctx).status).to.equal('pass');
  });

  it('fails for a metric that was not collected this run', () => {
    const ctx = baseContext();
    ctx.items[0].metric = 'cht_made_up_total';
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('cht_made_up_total');
  });

  it('derives base metric names from expressions', () => {
    expect(baseMetricName('increase(cht_feedback_total{instance=~"$cht_instance"}[1d])'))
      .to.equal('cht_feedback_total');
    expect(baseMetricName('up{job="cht"}')).to.equal('up');
    expect(baseMetricName('cht_sentinel_backlog_count')).to.equal('cht_sentinel_backlog_count');
  });
});

describe('verify/checks/metrics_known: one item per identity (revision 34)', () => {
  it('refuses two items with the same metric and pattern card, naming both', () => {
    const ctx = baseContext();
    ctx.items.push({ ...ctx.items[0], why_now: 'the same metric again' });
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons).to.deep.equal([
      'items[1] repeats the identity of items[0] (metric cht_sentinel_backlog_count, card none); merge them into one '
      + 'item citing both candidate ids',
    ]);
    const cards = baseContext();
    cards.items.push({ ...cards.items[0], pattern_card: 'sentinel-stall' });
    expect(check(cards).status, 'a different card is a different identity').to.equal('pass');
  });
});
