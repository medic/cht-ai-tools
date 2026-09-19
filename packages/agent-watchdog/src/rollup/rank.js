'use strict';
// Ranking and placement of accepted items (FR-010, data-model.md Item).
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const BODY_SLOTS = 3;

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
 * Rank items by severity, confidence, persistence and id; the first three go in the post body.
 * @param {object} options
 * @param {object[]} options.items accepted items
 * @param {Map<string, object[]>} [options.feedbackByItem] feedback records by item id (US2)
 * @param {Map<string, number>} [options.previousItemIds] consecutive prior runs that contained each id
 */
const rankItems = ({ items, feedbackByItem = new Map(), previousItemIds = new Map() }) => {
  const withPersistence = items.map((item) => ({
    ...item,
    persisting_days: 1 + (previousItemIds.get(item.item_id) || 0),
  }));
  const influenced = applyFeedbackInfluence(withPersistence, feedbackByItem);
  return [...influenced].sort(compare).map((item, index) => ({
    ...item,
    rank: index + 1,
    placement: index < BODY_SLOTS ? 'body' : 'thread',
  }));
};

module.exports = { rankItems, applyFeedbackInfluence, feedbackAdjustments, SEVERITY_ORDER, BODY_SLOTS };
