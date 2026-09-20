'use strict';
// Ranking and placement of accepted items (FR-010, data-model.md Item), after matching merged pattern cards
// (FR-038, US6 scenario 4).
const { itemId } = require('../model/identity');
const { buildLayout, slotByKey, BODY_SLOTS } = require('./layout');

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const CONFIDENCE_MAX = 1;
const CONFIDENCE_FLOOR = 0.05;
const UP_STEP = 0.1;
const DOWN_STEP = 0.15;

const lookup = (feedbackByItem, itemId) => {
  if (!feedbackByItem) {
    return undefined;
  }
  return feedbackByItem instanceof Map ? feedbackByItem.get(itemId) : feedbackByItem[itemId];
};

const round4 = (value) => Number(value.toFixed(4));

/** Confidence after feedback (FR-029): confirmed raises it per net up, dismissed lowers it per net down. */
const adjustedConfidence = (item, entry) => {
  if (!entry) {
    return item.confidence;
  }
  const net = (entry.up || 0) - (entry.down || 0);
  if (entry.verdict === 'confirmed' && net > 0) {
    return round4(Math.min(CONFIDENCE_MAX, item.confidence + UP_STEP * net));
  }
  if (entry.verdict === 'dismissed' && net < 0) {
    return round4(Math.max(CONFIDENCE_FLOOR, item.confidence + DOWN_STEP * net));
  }
  return item.confidence;
};

/** Log-friendly view of what feedback did to each item's confidence. */
const feedbackAdjustments = (items, feedbackByItem) => items
  .map((item) => {
    const entry = lookup(feedbackByItem, item.item_id);
    if (!entry) {
      return null;
    }
    const after = adjustedConfidence(item, entry);
    return { item_id: item.item_id, before: item.confidence, after, verdict: entry.verdict };
  })
  .filter(Boolean);

/** Items with feedback-adjusted confidence; no new fields, inputs untouched. */
const applyFeedbackInfluence = (items, feedbackByItem) => items.map((item) => {
  const after = adjustedConfidence(item, lookup(feedbackByItem, item.item_id));
  return after === item.confidence ? item : { ...item, confidence: after };
});

const cardById = (cards, cardId) => {
  if (typeof cards.get === 'function') {
    return cards.get(cardId) || null;
  }
  return null;
};

/** The merged card an item should carry: the one it already names when that exists, else the lowest id match. */
const cardFor = (item, cards) => {
  const named = item.pattern_card ? cardById(cards, item.pattern_card) : null;
  if (named) {
    return named;
  }
  const matches = cards.byMetric(item.metric) || [];
  if (!matches.length) {
    return null;
  }
  return [...matches].sort((a, b) => a.card_id.localeCompare(b.card_id))[0];
};

/**
 * Attach merged pattern cards to items by metric. The card's reviewed confirmation steps replace the model's
 * suggested check, because they are the confirmation the spec wants shown (US6 scenario 4), and the item id is
 * recomputed because identity includes the card (data-model.md Item). Inputs are not mutated.
 * @returns {{ items: object[], matched: Array<{ item_id_before: string, item_id: string, card_id: string }> }}
 */
const matchPatternCards = (items, cards) => {
  if (!cards) {
    return { items, matched: [] };
  }
  const matched = [];
  const next = items.map((item) => {
    const card = cardFor(item, cards);
    if (!card) {
      return item;
    }
    const steps = (card.confirmation_steps || []).join(' ');
    const suggestedCheck = steps || item.suggested_check;
    if (card.card_id === item.pattern_card) {
      return suggestedCheck === item.suggested_check ? item : { ...item, suggested_check: suggestedCheck };
    }
    const withCard = {
      ...item,
      pattern_card: card.card_id,
      suggested_check: suggestedCheck,
      item_id: itemId(item.project_url, item.metric, card.card_id),
    };
    matched.push({ item_id_before: item.item_id, item_id: withCard.item_id, card_id: card.card_id });
    return withCard;
  });
  return { items: next, matched };
};

const compare = (a, b) => {
  const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (severity !== 0) {
    return severity;
  }
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }
  if (b.persisting_days !== a.persisting_days) {
    return b.persisting_days - a.persisting_days;
  }
  return a.item_id.localeCompare(b.item_id);
};

/**
 * Rank items by severity, confidence, persistence and id, then place them with the body layout rule
 * (src/rollup/layout.js): five slots, a programme's items sharing one slot as sub-bullets (FR-010, FR-069).
 * @param {object} options
 * @param {object[]} options.items accepted items
 * @param {Map<string, object[]>} [options.feedbackByItem] feedback records by item id (US2)
 * @param {Map<string, number>} [options.previousItemIds] consecutive prior runs that contained each id
 * @param {object|null} [options.cards] loaded pattern cards (src/corpus/cards.js); matched before persistence
 * @param {(projectUrl: string) => string} [options.groupOf] the project's group label; everything is "Other" without it
 * @param {object[]} [options.alertGroups] Alert Groups that take body slots of their own (FR-066)
 */
const rankItems = ({
  items, feedbackByItem = new Map(), previousItemIds = new Map(), cards = null, groupOf = undefined, alertGroups = [],
}) => {
  const withPersistence = matchPatternCards(items, cards).items.map((item) => ({
    ...item,
    persisting_days: 1 + (previousItemIds.get(item.item_id) || 0),
  }));
  const influenced = applyFeedbackInfluence(withPersistence, feedbackByItem);
  const sorted = [...influenced].sort(compare);
  const slots = slotByKey(buildLayout(sorted, { ...(groupOf ? { groupOf } : {}), alertGroups }));
  return sorted.map((item, index) => {
    const slot = slots.get(item.item_id) || null;
    return { ...item, rank: index + 1, placement: slot ? 'body' : 'thread', slot };
  });
};

module.exports = {
  rankItems, matchPatternCards, applyFeedbackInfluence, feedbackAdjustments, SEVERITY_ORDER, BODY_SLOTS,
};
