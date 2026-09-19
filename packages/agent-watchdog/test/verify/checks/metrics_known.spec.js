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
