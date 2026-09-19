'use strict';
// Ranking and placement of accepted items (FR-010, data-model.md Item).
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const BODY_SLOTS = 3;

/** Feedback influence on ranking arrives with User Story 2; the hook keeps the call site stable. */
const applyFeedbackInfluence = (items) => items;

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

module.exports = { rankItems, applyFeedbackInfluence, SEVERITY_ORDER, BODY_SLOTS };
