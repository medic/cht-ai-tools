'use strict';
// Map a thread note to an item by explicit reference only (FR-027): item id, metric, host, or a combination.
const HEX_ID = /\b[0-9a-f]{12}\b/g;

const hostOf = (projectUrl) => {
  try {
    return new URL(projectUrl).host.toLowerCase();
  } catch {
    return String(projectUrl || '').toLowerCase();
  }
};

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const wordMatch = (text, form) => new RegExp(`(^|[^a-z0-9_])${escape(form)}([^a-z0-9_]|$)`, 'i').test(text);

/** The forms in which a metric key may be written in prose. */
const metricForms = (metric) => {
  const key = String(metric).toLowerCase();
  const base = key.split('{')[0];
  const forms = new Set([key]);
  if (base.length >= 4) {
    forms.add(base);
    forms.add(base.replace(/_/g, ' '));
    const trimmed = base.replace(/^cht_/, '').replace(/_(count|total|seconds|bytes|millis)$/, '');
    if (trimmed.includes('_') || trimmed.length >= 6) {
      forms.add(trimmed.replace(/_/g, ' '));
    }
  }
  return [...forms];
};

const metricMentioned = (text, metric) => metricForms(metric)
  .some((form) => (form.includes('{') ? text.includes(form) : wordMatch(text, form)));

/**
 * @returns {{ item: object|null, how: 'item_id'|'host+metric'|'metric'|'host'|null }}
 */
const matchNote = ({ text, items = [] }) => {
  const lower = String(text || '').toLowerCase();
  const ids = new Set(lower.match(HEX_ID) || []);
  const byId = items.find((item) => ids.has(item.item_id));
  if (byId) {
    return { item: byId, how: 'item_id' };
  }
  const hostHits = items.filter((item) => lower.includes(hostOf(item.project_url)));
  const metricHits = items.filter((item) => metricMentioned(lower, item.metric));
  const both = hostHits.filter((item) => metricHits.includes(item));
  if (both.length === 1) {
    return { item: both[0], how: 'host+metric' };
  }
  if (metricHits.length === 1) {
    return { item: metricHits[0], how: 'metric' };
  }
  if (hostHits.length === 1) {
    return { item: hostHits[0], how: 'host' };
  }
  return { item: null, how: null };
};

module.exports = { matchNote, metricForms, hostOf };
