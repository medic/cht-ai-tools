// Metric kinds (FR-076): the reviewed policy decides how a key is analysed; counters yield increases, uptimes
// yield restarts, clocks nothing.
const {
  bareKey, metricKind, increaseOver, dailyIncreases, restartsIn, RESTART_FRACTION,
} = require('../../src/analyze/kinds');

const KINDS = {
  clock: ['cht_date_current_millis'],
  uptime: ['cht_date_uptime_seconds'],
  counter: ['cht_couchdb_doc_total', 'cht_feedback_total', 'cht_messaging_outgoing_total{status="delivered"}'],
};

describe('analyze/kinds', () => {
  it('strips a display comparison and a plain sum wrapper to find the bare metric', () => {
    expect(bareKey('cht_conflict_count >= 0')).to.equal('cht_conflict_count');
    expect(bareKey('sum(cht_api_http_request_duration_seconds_count)'))
      .to.equal('cht_api_http_request_duration_seconds_count');
    expect(bareKey('cht_couchdb_doc_total{db="medic"} >= 0')).to.equal('cht_couchdb_doc_total{db="medic"}');
    expect(bareKey('rate(cht_feedback_total[24h]) * 60')).to.equal('rate(cht_feedback_total[24h]) * 60');
  });

  it('classifies bare names and labelled selectors, and treats derived expressions as gauges', () => {
    expect(metricKind('cht_couchdb_doc_total{db="medic"}', KINDS)).to.equal('counter');
    expect(metricKind('cht_couchdb_doc_total{db="medic"} >= 0', KINDS)).to.equal('counter');
    expect(metricKind('cht_feedback_total >= 0', KINDS)).to.equal('counter');
    expect(metricKind('increase(cht_feedback_total[1d])', KINDS), 'already a rate').to.equal('gauge');
    expect(metricKind('rate(cht_feedback_total[24h]) * 60 * 60 * 24', KINDS)).to.equal('gauge');
    expect(metricKind('cht_messaging_outgoing_total{status="delivered"}', KINDS)).to.equal('counter');
    expect(metricKind('cht_messaging_outgoing_total{status="due"}', KINDS), 'only the listed selector')
      .to.equal('gauge');
    expect(metricKind('cht_date_uptime_seconds', KINDS)).to.equal('uptime');
    expect(metricKind('cht_date_current_millis >= 0', KINDS)).to.equal('clock');
    expect(metricKind('floor(abs(cht_date_current_millis / 1000 - time()))', KINDS), 'skew is a gauge')
      .to.equal('gauge');
    expect(metricKind('cht_sentinel_backlog_count', KINDS)).to.equal('gauge');
    expect(metricKind('cht_sentinel_backlog_count', {})).to.equal('gauge');
  });

  it('computes increases with resets counted from zero, daily increases from maxima, and restarts', () => {
    expect(increaseOver([[0, 100], [300, 110], [600, 125]])).to.equal(25);
    expect(increaseOver([[0, 100], [300, 110], [600, 5], [900, 12]]), 'a reset to 5 counts as +5').to.equal(22);
    expect(increaseOver([[0, 100]])).to.equal(0);
    expect(increaseOver([])).to.equal(null);
    expect(dailyIncreases([[0, 1000], [86400, 1100], [172800, 1350], [259200, 20]]))
      .to.deep.equal([[86400, 100], [172800, 250], [259200, 20]]);
    expect(restartsIn([[0, 1000], [300, 1300], [600, 40], [900, 340], [1200, 320]])).to.equal(1);
    expect(restartsIn([[0, 2592000], [300, 2591000], [600, 2593000]]), 'jitter is not a restart').to.equal(0);
    expect(RESTART_FRACTION).to.equal(0.5);
  });
});
