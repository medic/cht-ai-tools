const { percentile, effectOf, suggestThreshold, roundUpToFive } = require('../../src/calibration/suggest');

const obs = (observed, outcome) => ({ item_id: `${observed}-${outcome}`, observed, outcome });
const range = (from, to, step = 1) => Array.from(
  { length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step,
);

describe('calibration/suggest', () => {
  describe('percentile (nearest rank)', () => {
    it('picks the nearest-rank value of the sorted list', () => {
      const values = [10, 1, 5, 3, 7, 9, 2, 8, 6, 4];
      expect(percentile(values, 50)).to.equal(5);
      expect(percentile(values, 90)).to.equal(9);
      expect(percentile(values, 95)).to.equal(10);
      expect(percentile(values, 100)).to.equal(10);
      expect(percentile(values, 0)).to.equal(1);
      expect(percentile([], 50)).to.equal(null);
      expect(values[0]).to.equal(10);
    });

    it('rounds up to the next multiple of five', () => {
      expect(roundUpToFive(71)).to.equal(75);
      expect(roundUpToFive(75)).to.equal(75);
      expect(roundUpToFive(0.2)).to.equal(5);
    });
  });

  describe('effectOf', () => {
    const observations = [obs(55, 'dismissed'), obs(120, 'confirmed'), obs(90, 'unreviewed')];

    it('counts kept, dropped and confirmed-kept items for a threshold', () => {
      expect(effectOf(80, observations)).to.deep.equal({ items_kept: 2, items_dropped: 1, confirmed_kept: 1 });
      expect(effectOf(130, observations)).to.deep.equal({ items_kept: 0, items_dropped: 3, confirmed_kept: 0 });
    });

    it('keeps everything for a null threshold', () => {
      expect(effectOf(null, observations)).to.deep.equal({ items_kept: 3, items_dropped: 0, confirmed_kept: 1 });
    });
  });

  describe('suggestThreshold', () => {
    it('gives no suggestion on thin evidence and reports the current effect', () => {
      const observations = [obs(60, 'dismissed'), obs(120, 'confirmed')];
      const result = suggestThreshold({ current: 50, observations, dailyValues: [10, 20, 60, 120, 30] });
      expect(result.suggested).to.equal(null);
      expect(result.reason).to.equal('insufficient data');
      expect(result.effect).to.deep.equal({ items_kept: 2, items_dropped: 0, confirmed_kept: 1 });
    });

    it('separates dismissed from confirmed with the smallest multiple of five above the dismissed maximum', () => {
      const observations = [
        obs(55, 'dismissed'), obs(60, 'dismissed'), obs(75, 'dismissed'), obs(120, 'confirmed'), obs(130, 'confirmed'),
        obs(90, 'unreviewed'),
      ];
      const result = suggestThreshold({ current: 50, observations, dailyValues: [] });
      expect(result.suggested).to.equal(80);
      expect(result.reason).to.match(/separates/);
      expect(result.effect).to.deep.equal({ items_kept: 3, items_dropped: 3, confirmed_kept: 2 });
    });

    it('falls back to evaluation when no multiple of five fits between dismissed and confirmed, and stays put', () => {
      const observations = [obs(78, 'dismissed'), obs(79, 'confirmed'), obs(120, 'confirmed')];
      const dailyValues = [10, 20, 30, 78, 79, 120, 40, 50, 60, 70, 20, 30, 40, 50, 60];
      const result = suggestThreshold({ current: 50, observations, dailyValues });
      expect(result.suggested).to.equal(null);
      expect(result.reason).to.equal('no improving threshold');
      expect(result.effect).to.deep.equal({ items_kept: 3, items_dropped: 0, confirmed_kept: 2 });
    });

    it('when outcomes overlap, picks the multiple of five that drops dismissed items at least confirmed cost', () => {
      const observations = [obs(60, 'dismissed'), obs(100, 'dismissed'), obs(70, 'confirmed'), obs(130, 'confirmed')];
      const dailyValues = [30, 40, 60, 70, 100, 130, 140];
      const result = suggestThreshold({ current: 50, observations, dailyValues });
      expect(result.suggested).to.equal(65);
      expect(result.reason).to.match(/overlap/);
      expect(result.effect).to.deep.equal({ items_kept: 3, items_dropped: 1, confirmed_kept: 2 });
    });

    it('suggests the rounded 90th percentile when the rule fires on most days and nothing was dismissed', () => {
      const observations = [obs(55, 'unreviewed'), obs(70, 'unreviewed'), obs(90, 'unreviewed')];
      const dailyValues = [20, 25, 30, 35, 40, 45, ...range(55, 115, 5), 118];
      expect(dailyValues).to.have.length(20);
      const result = suggestThreshold({ current: 50, observations, dailyValues });
      expect(result.suggested).to.equal(110);
      expect(result.reason).to.match(/most days/);
    });

    it('makes no suggestion when nothing was dismissed and the rule fires rarely', () => {
      const observations = [obs(120, 'confirmed'), obs(130, 'confirmed'), obs(90, 'unreviewed')];
      const dailyValues = [10, 20, 30, 120, 130, 90, 15, 25, 35, 12, 22, 32, 18, 28];
      const result = suggestThreshold({ current: 50, observations, dailyValues });
      expect(result.suggested).to.equal(null);
      expect(result.reason).to.equal('no dismissed items');
      expect(result.effect).to.deep.equal({ items_kept: 3, items_dropped: 0, confirmed_kept: 2 });
    });

    it('withholds a suggestion within ten percent of the current threshold', () => {
      const observations = [obs(52, 'dismissed'), obs(51, 'dismissed'), obs(120, 'confirmed')];
      const result = suggestThreshold({ current: 50, observations, dailyValues: [] });
      expect(result.suggested).to.equal(null);
      expect(result.reason).to.equal('within tolerance');
    });
  });
});
