'use strict';
// Map a thread note to an item by explicit reference only (FR-027): its rank in the report (`#7`, revision 23), item
// id, metric, host, or a combination.
const HEX_ID = /\b[0-9a-f]{12}\b/g;
// `#7` as a person writes it in a note; `#7a`, `a#7` and `##7` are not citations.
const RANK_REFERENCE = /(?<![\w#])#(\d{1,4})(?![\w#])/g;
// A thumbs written in a note, as Slack delivers it: the shortcode, its alias, or the emoji itself (revision 23).
const THUMBS_UP = /:\+1:|:thumbsup:|\u{1F44D}/u;
const THUMBS_DOWN = /:-1:|:thumbsdown:|\u{1F44E}/u;

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

/** The ranks a note cites (`#7`), in order of appearance, each once. */
const ranksCited = (text) => [...new Set([...String(text || '').matchAll(RANK_REFERENCE)].map((m) => Number(m[1])))];

/** The verdict a note carries in a thumbs, or null when it carries none or both (FR-027, revision 23). */
const noteVerdict = (text) => {
  const source = String(text || '');
  const up = THUMBS_UP.test(source);
  const down = THUMBS_DOWN.test(source);
  if (up === down) {
    return null;
  }
  return up ? 'up' : 'down';
};

/**
 * @returns {{ item: object|null, how: 'rank'|'item_id'|'host+metric'|'metric'|'host'|null }}
 */
const matchNote = ({ text, items = [] }) => {
  const lower = String(text || '').toLowerCase();
  for (const rank of ranksCited(lower)) {
    const byRank = items.find((item) => item.rank === rank);
    if (byRank) {
      return { item: byRank, how: 'rank' };
    }
  }
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

/**
 * Map a thread note to an Alert Group (FR-066): the note must mention alerts and name the programme; the category
 * settles it when the programme has several groups, otherwise the programme must have exactly one.
 * @returns {{ alertKey: string|null }}
 */
const matchAlertNote = ({ text, alertGroups = [] }) => {
  const lower = String(text || '').toLowerCase();
  if (!/\balerts?\b/.test(lower)) {
    return { alertKey: null };
  }
  const byGroup = alertGroups.filter((group) => lower.includes(String(group.group).toLowerCase()));
  if (!byGroup.length) {
    return { alertKey: null };
  }
  const withCategory = byGroup.filter((group) => wordMatch(lower, String(group.category).toLowerCase()));
  if (withCategory.length === 1) {
    return { alertKey: withCategory[0].alert_key };
  }
  return byGroup.length === 1 ? { alertKey: byGroup[0].alert_key } : { alertKey: null };
};

module.exports = { matchNote, matchAlertNote, metricForms, hostOf, noteVerdict, ranksCited };
