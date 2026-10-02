// Status and severity markers placed by code (FR-015, FR-082): a small fixed vocabulary, never written by the model.
const {
  headlineMarker, bulletMarker, noticeMarker, withMarker, MARKERS,
} = require('../../src/rollup/markers');

describe('rollup/markers', () => {
  const severityOf = (id) => ({ hi: 'high', med: 'medium', lo: 'low' })[id];

  it('marks the headline by the brief kind, with the alarm for an alerts-only brief', () => {
    expect(headlineMarker({ kind: 'brief', bullets: [{ kind: 'item' }] })).to.equal(MARKERS.brief);
    expect(headlineMarker({ kind: 'brief', bullets: [{ kind: 'alerts' }, { kind: 'alerts' }] }))
      .to.equal(MARKERS.alerts);
    expect(headlineMarker({ kind: 'heartbeat', bullets: [] })).to.equal(MARKERS.heartbeat);
    expect(headlineMarker({ kind: 'degraded', bullets: [] })).to.equal(MARKERS.degraded);
    expect(headlineMarker({ kind: 'failure', bullets: [] })).to.equal(MARKERS.failure);
  });

  it('marks item bullets by severity, group bullets by their worst child, alert bullets with the alarm', () => {
    expect(bulletMarker({ kind: 'item', item_id: 'hi' }, severityOf)).to.equal(MARKERS.high);
    expect(bulletMarker({ kind: 'item', item_id: 'lo' }, severityOf)).to.equal(MARKERS.low);
    expect(bulletMarker({ kind: 'group', children: [{ item_id: 'lo' }, { item_id: 'med' }] }, severityOf))
      .to.equal(MARKERS.medium);
    expect(bulletMarker({ kind: 'group', children: [] }, severityOf)).to.equal('');
    expect(bulletMarker({ kind: 'alerts' }, severityOf)).to.equal(MARKERS.alerts);
    expect(bulletMarker({ kind: 'item', item_id: 'unknown' }, severityOf)).to.equal('');
  });

  it('marks notices by what they say and joins marker and text with one space', () => {
    expect(noticeMarker('Resolved since the previous run: x')).to.equal(MARKERS.resolved);
    expect(noticeMarker('Housekeeping: 7 alerts stale')).to.equal(MARKERS.housekeeping);
    expect(noticeMarker('First run: 3 projects analysed')).to.equal(MARKERS.newProject);
    expect(noticeMarker('New projects: a.example.org')).to.equal(MARKERS.newProject);
    expect(noticeMarker('Analysis incomplete: model sessions failed')).to.equal(MARKERS.warning);
    expect(noticeMarker('Alerts unavailable: timeout')).to.equal(MARKERS.warning);
    expect(noticeMarker('Collection incomplete: 12 of 12 queries failed')).to.equal(MARKERS.warning);
    expect(noticeMarker('Something else')).to.equal('');
    expect(withMarker(MARKERS.high, 'text')).to.equal(`${MARKERS.high} text`);
    expect(withMarker('', 'text')).to.equal('text');
  });
});
