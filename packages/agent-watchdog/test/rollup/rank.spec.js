const { rankItems, applyFeedbackInfluence } = require('../../src/rollup/rank');
const { makeItem } = require('./factories');

describe('rollup/rank', () => {
  it('orders by severity, then confidence, then persisting days, then item id, and assigns rank and placement', () => {
    const low = makeItem({ metric: 'a_metric', severity: 'low', confidence: 0.9 });
    const mediumHighConfidence = makeItem({ metric: 'b_metric', severity: 'medium', confidence: 0.9 });
    const mediumLowConfidence = makeItem({ metric: 'c_metric', severity: 'medium', confidence: 0.4 });
    const high = makeItem({ metric: 'd_metric', severity: 'high', confidence: 0.5 });
    const ranked = rankItems({ items: [low, mediumLowConfidence, mediumHighConfidence, high] });
    expect(ranked.map((i) => i.metric)).to.deep.equal(['d_metric', 'b_metric', 'c_metric', 'a_metric']);
    expect(ranked.map((i) => i.rank)).to.deep.equal([1, 2, 3, 4]);
    expect(ranked.map((i) => i.placement)).to.deep.equal(['body', 'body', 'body', 'body']);
    expect(ranked.map((i) => i.slot)).to.deep.equal([1, 2, 3, 4]);
  });

  it('fills five body slots and sends the sixth item to the thread (FR-010, revision 9)', () => {
    const { BODY_SLOTS } = require('../../src/rollup/rank');
    expect(BODY_SLOTS).to.equal(5);
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((m) => makeItem({ metric: `${m}_metric`, severity: 'low' }));
    const ranked = rankItems({ items });
    expect(ranked.map((i) => i.placement)).to.deep.equal(['body', 'body', 'body', 'body', 'body', 'thread']);
    expect(ranked[5].slot).to.equal(null);
  });

  it('places items of one programme in a shared slot when groupOf names their group (FR-069)', () => {
    const groups = { 'https://north-a.example.org': 'North Programme', 'https://north-b.example.org': 'North Programme' };
    const groupOf = (url) => groups[url] || 'Other';
    const ranked = rankItems({
      items: [
        makeItem({ project_url: 'https://north-a.example.org', confidence: 0.9 }),
        makeItem({ project_url: 'https://alpha.example.org', confidence: 0.8 }),
        makeItem({ project_url: 'https://north-b.example.org', confidence: 0.7 }),
      ],
      groupOf,
    });
    expect(ranked.map((i) => i.slot)).to.deep.equal([1, 2, 1]);
    expect(ranked.map((i) => i.placement)).to.deep.equal(['body', 'body', 'body']);
  });

  it('ranks the most-used projects first within a severity when usersOf is given (FR-081)', () => {
    const small = makeItem({ project_url: 'https://small.example.org', metric: 'a', severity: 'medium', confidence: 0.9 });
    const large = makeItem({ project_url: 'https://large.example.org', metric: 'b', severity: 'medium', confidence: 0.5 });
    const high = makeItem({ project_url: 'https://small.example.org', metric: 'c', severity: 'high', confidence: 0.3 });
    const users = { 'https://small.example.org': 40, 'https://large.example.org': 3800 };
    const ranked = rankItems({ items: [small, large, high], usersOf: (url) => users[url] || 0 });
    expect(ranked.map((i) => i.metric)).to.deep.equal(['c', 'b', 'a']);
    // Within one order of magnitude of users, confidence still decides.
    const peer = makeItem({ project_url: 'https://peer.example.org', metric: 'd', severity: 'medium', confidence: 0.95 });
    const withPeer = rankItems({
      items: [small, large, peer], usersOf: (url) => ({ ...users, 'https://peer.example.org': 1200 })[url] || 0,
    });
    expect(withPeer.map((i) => i.metric)).to.deep.equal(['d', 'b', 'a']);
  });

  it('breaks ties on persisting days then item id, deterministically', () => {
    const a = makeItem({ metric: 'm1', confidence: 0.7 });
    const b = makeItem({ metric: 'm2', confidence: 0.7 });
    const previous = new Map([[b.item_id, 3]]);
    const ranked = rankItems({ items: [a, b], previousItemIds: previous });
    expect(ranked[0].item_id).to.equal(b.item_id);
    expect(ranked[0].persisting_days).to.equal(4);
    expect(ranked[1].persisting_days).to.equal(1);
    const again = rankItems({ items: [b, a], previousItemIds: previous });
    expect(again.map((i) => i.item_id)).to.deep.equal(ranked.map((i) => i.item_id));
  });

  it('does not mutate the input items', () => {
    const item = makeItem();
    rankItems({ items: [item] });
    expect(item.rank).to.equal(null);
    expect(item.placement).to.equal(null);
  });

  it('keeps the feedback hook stable and neutral for now', () => {
    const items = [makeItem()];
    expect(applyFeedbackInfluence(items, new Map())).to.deep.equal(items);
  });
});

describe('rollup/rank: pattern-card matching (US6 scenario 4)', () => {
  const { itemId } = require('../../src/model/identity');
  const card = {
    card_id: 'sentinel-stall', title: 't', metrics: [{ metric: 'cht_sentinel_backlog_count', shape: 's' }],
    confirmation_steps: ['Step one.', 'Step two.'], status: 'merged',
  };
  const cards = {
    byMetric: (metric) => (metric === 'cht_sentinel_backlog_count' ? [card] : []),
    get: (id) => (id === card.card_id ? card : null),
  };

  it('matches before persistence and feedback, so both are keyed by the recomputed item id', () => {
    const item = makeItem({ pattern_card: null, confidence: 0.5 });
    const newId = itemId(item.project_url, item.metric, 'sentinel-stall');
    const previousItemIds = new Map([[newId, 2]]);
    const feedbackByItem = new Map([[newId, { verdict: 'confirmed', up: 1, down: 0 }]]);
    const [ranked] = rankItems({ items: [item], cards, previousItemIds, feedbackByItem });
    expect(ranked.item_id).to.equal(newId);
    expect(ranked.pattern_card).to.equal('sentinel-stall');
    expect(ranked.suggested_check).to.equal('Step one. Step two.');
    expect(ranked.persisting_days).to.equal(3);
    expect(ranked.confidence).to.equal(0.6);
  });

  it('does nothing without cards', () => {
    const item = makeItem({ pattern_card: null });
    expect(rankItems({ items: [item] })[0].item_id).to.equal(item.item_id);
    expect(rankItems({ items: [item], cards: null })[0].pattern_card).to.equal(null);
  });
});
