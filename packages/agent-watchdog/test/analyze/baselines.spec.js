const { mean, stddev, pctChange, monotonicRunHours } = require('../../src/analyze/baselines');

describe('analyze/baselines', () => {
  it('computes the mean and population standard deviation', () => {
    expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).to.equal(5);
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).to.equal(2);
    expect(mean([])).to.equal(null);
    expect(stddev([3])).to.equal(0);
  });

  it('computes percentage change against the absolute baseline and returns null for a zero or missing baseline', () => {
    expect(pctChange(912, 300)).to.be.closeTo(204, 1e-9);
    expect(pctChange(50, -100)).to.equal(150);
    expect(pctChange(10, 0)).to.equal(null);
    expect(pctChange(10, null)).to.equal(null);
    expect(pctChange(null, 10)).to.equal(null);
  });

  it('measures the rise ending at the last sample, in hours', () => {
    const rising = Array.from({ length: 85 }, (_, i) => [i * 300, 300 + i]);
    expect(monotonicRunHours(rising, 300)).to.equal(7);
    const plateau = [...rising, [85 * 300, 384], [86 * 300, 384]];
    expect(monotonicRunHours(plateau, 300)).to.be.closeTo(7 + 2 / 12, 1e-9);
    const fell = [...rising, [85 * 300, 383]];
    expect(monotonicRunHours(fell, 300)).to.equal(0);
  });

  it('treats a flat line as no rise and requires at least two samples', () => {
    const flat = Array.from({ length: 50 }, (_, i) => [i * 300, 0]);
    expect(monotonicRunHours(flat, 300)).to.equal(0);
    expect(monotonicRunHours([[0, 1]], 300)).to.equal(0);
    expect(monotonicRunHours([], 300)).to.equal(0);
  });
});
