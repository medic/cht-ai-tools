const { rankItems, applyFeedbackInfluence, feedbackAdjustments } = require('../../src/rollup/rank');
const { makeItem } = require('./factories');

const entry = (over) => ({
  project_url: 'https://alpha.example.org', metric: 'm', pattern_card: null, up: 0, down: 0, retracted: 0,
  notes: [], verdict: 'unreviewed', horizon: null, ...over,
});

describe('rollup/rank feedback influence (FR-029)', () => {
  it('ranks a confirmed item above a dismissed one at equal severity and starting confidence', () => {
    const confirmed = makeItem({ metric: 'm_confirmed', confidence: 0.6 });
    const dismissed = makeItem({ metric: 'm_dismissed', confidence: 0.6 });
    const feedback = new Map([
      [confirmed.item_id, entry({ up: 1, verdict: 'confirmed' })],
      [dismissed.item_id, entry({ down: 1, verdict: 'dismissed' })],
    ]);
    const ranked = rankItems({ items: [dismissed, confirmed], feedbackByItem: feedback });
    expect(ranked[0].item_id).to.equal(confirmed.item_id);
    expect(ranked[0].confidence).to.equal(0.7);
    expect(ranked[1].confidence).to.equal(0.45);
  });

  it('raises confidence by 0.2 for two thumbs-up', () => {
    const item = makeItem({ confidence: 0.5 });
    const feedback = new Map([[item.item_id, entry({ up: 2, verdict: 'confirmed' })]]);
    const [influenced] = applyFeedbackInfluence([item], feedback);
    expect(influenced.confidence).to.equal(0.7);
  });

  it('caps confidence at 1 and floors it at 0.05', () => {
    const high = makeItem({ metric: 'm_high', confidence: 0.95 });
    const low = makeItem({ metric: 'm_low', confidence: 0.1 });
    const feedback = new Map([
      [high.item_id, entry({ up: 3, verdict: 'confirmed' })],
      [low.item_id, entry({ down: 2, verdict: 'dismissed' })],
    ]);
    const [h, l] = applyFeedbackInfluence([high, low], feedback);
    expect(h.confidence).to.equal(1);
    expect(l.confidence).to.equal(0.05);
  });

  it('leaves contested and unreviewed items unchanged and accepts a plain object as the map', () => {
    const contested = makeItem({ metric: 'm_contested', confidence: 0.6 });
    const unreviewed = makeItem({ metric: 'm_unreviewed', confidence: 0.6 });
    const feedback = { [contested.item_id]: entry({ up: 1, down: 1, verdict: 'contested' }) };
    const result = applyFeedbackInfluence([contested, unreviewed], feedback);
    expect(result.map((i) => i.confidence)).to.deep.equal([0.6, 0.6]);
  });

  it('reports adjustments for logging without adding fields to items or mutating them', () => {
    const item = makeItem({ confidence: 0.5 });
    const feedback = new Map([[item.item_id, entry({ up: 1, verdict: 'confirmed' })]]);
    const adjustments = feedbackAdjustments([item], feedback);
    expect(adjustments).to.deep.equal([{ item_id: item.item_id, before: 0.5, after: 0.6, verdict: 'confirmed' }]);
    const [influenced] = applyFeedbackInfluence([item], feedback);
    expect(Object.keys(influenced).sort()).to.deep.equal(Object.keys(item).sort());
    expect(item.confidence).to.equal(0.5);
  });
});
