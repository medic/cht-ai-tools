'use strict';
// The feedback digest (FR-062, data-model.md "Feedback Digest"): one code-built thread reply per run that
// acknowledges every feedback record no earlier digest covered, says what each changed today, names the
// proposals written from notes, and states where the records live and for how long they adjust ranking.
// It names no person: authors are counted, never shown, and Slack mentions inside notes are masked.
const fs = require('node:fs');
const path = require('node:path');
const Handlebars = require('handlebars');
const { mrkdwn } = require('./payload');
const { hostOf } = require('../rollup/deterministic-brief');
const { maskPeople } = require('../corpus/scrub');

const DIGEST_EVENT = 'agent_watchdog.feedback_digest';
const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'slack', 'feedback-digest.hbs');
const DESTINATIONS = {
  project_annotation: 'projects.yaml annotation',
  skill: 'the skill',
  prompt: 'a prompt',
  threshold: 'a threshold',
  pattern_card: 'a pattern card',
};

const handlebars = Handlebars.create();
handlebars.registerHelper('mrkdwn', (value) => mrkdwn(value));
let compiled = null;
const template = () => {
  if (!compiled) {
    const text = fs.readFileSync(TEMPLATE, 'utf8');
    if (text.includes('{{{')) {
      throw new Error('triple-stash is forbidden in templates/slack/feedback-digest.hbs');
    }
    compiled = handlebars.compile(text, { strict: true, noEscape: true });
  }
  return compiled;
};


/** Untrusted note text with every Slack mention or bare user id replaced, so no person is named. */

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const number = (value) => (typeof value === 'number' ? String(Number(value.toFixed(2))) : null);

/**
 * What today's run did with an item's feedback: suppressed until a noted horizon, confidence raised or
 * lowered, or nothing. `adjustments` entries carry either before/after confidences or a `direction`.
 */
const effectFor = ({ itemId, adjustments = [], suppressed = [] }) => {
  const held = (suppressed || []).find((s) => s.item_id === itemId);
  if (held) {
    return { effect: 'suppressed', until: held.horizon || null };
  }
  const adjustment = (adjustments || []).find((a) => a.item_id === itemId);
  if (!adjustment) {
    return { effect: 'none', until: null };
  }
  let direction = adjustment.direction || null;
  if (!direction && typeof adjustment.before === 'number' && typeof adjustment.after === 'number') {
    if (adjustment.after > adjustment.before) {
      direction = 'up';
    } else if (adjustment.after < adjustment.before) {
      direction = 'down';
    }
  }
  if (!direction) {
    return { effect: 'none', until: null };
  }
  const effect = direction === 'up' ? 'confidence_up' : 'confidence_down';
  const out = { effect, until: null };
  if (typeof adjustment.before === 'number') {
    out.before = adjustment.before;
  }
  if (typeof adjustment.after === 'number') {
    out.after = adjustment.after;
  }
  return out;
};

const effectText = (entry) => {
  if (entry.effect === 'suppressed') {
    return `suppressed until ${entry.until}`;
  }
  if (entry.effect === 'none') {
    return 'no change today';
  }
  const verb = entry.effect === 'confidence_up' ? 'confidence raised' : 'confidence lowered';
  if (typeof entry.before === 'number' && typeof entry.after === 'number') {
    return `${verb} from ${number(entry.before)} to ${number(entry.after)}`;
  }
  if (typeof entry.after === 'number') {
    return `${verb} to ${number(entry.after)}`;
  }
  return verb;
};

const tallyText = (entry) => {
  const parts = [];
  if (entry.up) {
    parts.push(plural(entry.up, 'thumbs-up', 'thumbs-up'));
  }
  if (entry.down) {
    parts.push(plural(entry.down, 'thumbs-down', 'thumbs-down'));
  }
  if (entry.notes) {
    parts.push(plural(entry.notes, 'note'));
  }
  return parts.length ? parts.join(', ') : 'no new reactions';
};

const lookup = (byItem, itemId) => {
  if (!byItem) {
    return undefined;
  }
  return byItem instanceof Map ? byItem.get(itemId) : byItem[itemId];
};

const identityOf = (itemId, byItem, items) => {
  const known = lookup(byItem, itemId) || (items || []).find((item) => item.item_id === itemId) || {};
  const host = known.project_url ? hostOf(known.project_url) : (known.host || 'unknown project');
  return { host, metric: known.metric || 'unknown metric' };
};

const countInto = (target, record) => {
  if (record.kind === 'note') {
    target.notes += 1;
  } else if (record.verdict === 'up') {
    target.up += 1;
  } else if (record.verdict === 'down') {
    target.down += 1;
  }
};

/**
 * @param {object} options
 * @param {object[]} options.records unacknowledged Feedback records
 * @param {Map|object} [options.byItem] the day's per-item tallies (project_url, metric)
 * @param {object[]} [options.items] ranked items, for identities the tallies do not carry
 * @param {object[]} [options.adjustments] confidence effects per item (before/after or direction)
 * @param {object[]} [options.suppressed] candidates suppressed by a noted horizon (item_id, horizon)
 * @param {object} [options.review] { classified: [...], unclassified: [...] } from the feedback review
 * @param {Array<string|{ note: string }>} [options.unmatched] notes that matched no item
 * @param {{ records_path: string, influence_days: number }} options.retention
 * @returns {{ digest: object, text: string, blocks: object[], metadata: object } | null}
 */
const buildDigest = ({
  runId, date, records = [], byItem = {}, items = [], adjustments = [], suppressed = [], review = null,
  unmatched = [], retention,
}) => {
  if (!records.length) {
    return null;
  }
  const perItem = new Map();
  const brief = { up: 0, down: 0, notes: 0 };
  for (const record of records) {
    if (record.target === 'item' && record.item_id) {
      if (!perItem.has(record.item_id)) {
        perItem.set(record.item_id, { item_id: record.item_id, up: 0, down: 0, notes: 0 });
      }
      countInto(perItem.get(record.item_id), record);
    } else {
      countInto(brief, record);
    }
  }
  const digestItems = [...perItem.values()].map((entry) => ({
    ...entry,
    ...identityOf(entry.item_id, byItem, items),
    ...effectFor({ itemId: entry.item_id, adjustments, suppressed }),
  }));
  const classified = (review && Array.isArray(review.classified)) ? review.classified : [];
  const proposals = classified.filter((c) => c.proposal_id).map((c) => ({
    proposal_id: c.proposal_id, type: c.classification, path: c.proposal_path || null,
  }));
  const destinations = classified.filter((c) => c.proposal_id).map((c) => (
    c.destination || DESTINATIONS[c.classification] || c.classification
  ));
  const unmatchedNotes = (unmatched || [])
    .map((n) => (typeof n === 'string' ? n : n && n.note))
    .filter(Boolean)
    .map((note) => ({ note: maskPeople(note) }));
  const unclassified = (review && Array.isArray(review.unclassified)) ? review.unclassified.length : 0;
  const reactions = records.filter((r) => r.kind === 'reaction' && r.verdict !== 'retracted').length;
  const notes = records.filter((r) => r.kind === 'note').length;

  const digest = {
    run_id: runId,
    acknowledged: records.map((r) => r.feedback_id),
    items: digestItems,
    brief,
    proposals,
    unmatched: unmatchedNotes,
    unclassified,
    retention: { records_path: retention.records_path, influence_days: retention.influence_days },
    reactions: [],
    publication: null,
  };

  const view = {
    summary_text: `${plural(reactions, 'reaction')}, ${plural(notes, 'note')}`,
    items: digestItems.map((entry) => ({
      host: entry.host, metric: entry.metric, tally_text: tallyText(entry), effect_text: effectText(entry),
    })),
    has_brief: brief.up + brief.down + brief.notes > 0,
    brief_text: tallyText(brief),
    has_proposals: proposals.length > 0,
    proposals: proposals.map((p, i) => ({ destination_text: destinations[i], path_text: p.path || p.proposal_id })),
    has_unmatched: unmatchedNotes.length > 0,
    unmatched_count: String(unmatchedNotes.length),
    unmatched: unmatchedNotes.map((n) => n.note),
    has_unclassified: unclassified > 0,
    unclassified_text: `${plural(unclassified, 'note')} awaiting classification; the next run will review ${
      unclassified === 1 ? 'it' : 'them'}.`,
    retention_text: `Records are kept permanently at ${retention.records_path}; feedback adjusts ranking for `
      + `${retention.influence_days} days. Adopting a proposal makes it permanent.`,
  };
  const text = template()(view).trim();

  const section = (body) => ({ type: 'section', text: { type: 'mrkdwn', text: body } });
  const itemLines = [
    `Feedback from yesterday: ${mrkdwn(view.summary_text)}`,
    ...view.items.map((i) => (
      `• ${mrkdwn(i.host)} \`${mrkdwn(i.metric)}\`: ${mrkdwn(i.tally_text)}; ${mrkdwn(i.effect_text)}`
    )),
    ...(view.has_brief ? [`• the brief itself: ${mrkdwn(view.brief_text)}`] : []),
  ];
  const blocks = [section(itemLines.join('\n'))];
  if (view.has_proposals) {
    const lines = view.proposals.map((p) => `• ${mrkdwn(p.destination_text)}: ${mrkdwn(p.path_text)}`);
    blocks.push(section(`_Proposals written for review:_\n${lines.join('\n')}`));
  }
  if (view.has_unmatched) {
    const lines = view.unmatched.map((n) => `• ${mrkdwn(n)}`);
    blocks.push(section(`_Notes I could not match to an item_ (${view.unmatched_count}):\n${lines.join('\n')}\n`
      + 'Mention the project host or the metric in a note so the next run can attach it.'));
  }
  if (view.has_unclassified) {
    blocks.push(section(mrkdwn(view.unclassified_text)));
  }
  blocks.push(section(mrkdwn(view.retention_text)));

  const metadata = {
    event_type: DIGEST_EVENT,
    event_payload: { run_id: runId, date, acknowledged: records.length },
  };
  return { digest, text, blocks, metadata };
};

module.exports = { buildDigest, effectFor, effectText, tallyText, maskPeople, DIGEST_EVENT, DESTINATIONS };
