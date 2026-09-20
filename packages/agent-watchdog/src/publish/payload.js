'use strict';
// The exact Slack payload (contracts/slack-payload.md): built by code, escaped through templates, and the
// same object whether previewed or posted (FR-019, FR-020, FR-025).
const fs = require('node:fs');
const path = require('node:path');
const Handlebars = require('handlebars');
const { assertAudience } = require('./audience');
const { hostOf } = require('../rollup/deterministic-brief');
const { formatCost } = require('./footer');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates', 'slack');
const HEADER_MAX = 150;
const TEXT_MAX = 4000;
const BRIEF_EVENT = 'agent_watchdog.brief';
const ITEM_EVENT = 'agent_watchdog.item';

/** Slack mrkdwn needs exactly these three escapes for untrusted text. */
const mrkdwn = (value) => String(value === undefined || value === null ? '' : value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const link = (url, label) => `<${url}|${mrkdwn(label)}>`;

const handlebars = Handlebars.create();
handlebars.registerHelper('mrkdwn', (value) => mrkdwn(value));
handlebars.registerHelper('link', (url, label) => link(url, label));

const compiled = new Map();
const template = (templateName) => {
  if (!compiled.has(templateName)) {
    const text = fs.readFileSync(path.join(TEMPLATES, `${templateName}.hbs`), 'utf8');
    if (text.includes('{{{')) {
      throw new Error(`triple-stash is forbidden in templates/slack/${templateName}.hbs`);
    }
    compiled.set(templateName, handlebars.compile(text, { strict: true, noEscape: true }));
  }
  return compiled.get(templateName);
};

const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const footerText = (footer) => {
  const parts = [link(footer.prompts_url, 'prompts'), link(footer.config_url, 'configuration')];
  if (footer.trace_url) {
    parts.push(link(footer.trace_url, 'trace'));
  }
  parts.push(`cost ${formatCost(footer.cost_usd)}`);
  return parts.join(' · ');
};

const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

const imageBlock = (fileId, altText) => ({ type: 'image', slack_file: { id: fileId }, alt_text: altText });

const parentBlocks = (brief) => {
  const headerText = { type: 'plain_text', text: truncate(brief.headline, HEADER_MAX), emoji: true };
  const blocks = [{ type: 'header', text: headerText }];
  for (const bullet of brief.bullets) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: mrkdwn(bullet.text) } });
  }
  if (brief.image && brief.image.slack_file_id) {
    blocks.push(imageBlock(brief.image.slack_file_id, brief.headline));
  }
  if (brief.expected_load_notice) {
    blocks.push(context(`_${mrkdwn(brief.expected_load_notice)}_`));
  }
  if (brief.degradation_notice) {
    blocks.push(context(`_${mrkdwn(brief.degradation_notice)}_`));
  }
  blocks.push(context(footerText(brief.footer)));
  return blocks;
};

const rankOrder = (a, b) => {
  const ra = a.rank === null || a.rank === undefined ? Number.MAX_SAFE_INTEGER : a.rank;
  const rb = b.rank === null || b.rank === undefined ? Number.MAX_SAFE_INTEGER : b.rank;
  return ra - rb || a.item_id.localeCompare(b.item_id);
};

const replyFor = ({ item, links, runId }) => {
  const url = links.get(item.item_id) || null;
  const text = template('reply')({
    severity_label: item.severity.toUpperCase(),
    host: hostOf(item.project_url),
    metric: item.metric,
    why_now: item.why_now,
    suggested_check: item.suggested_check,
    has_link: Boolean(url),
    link_url: url,
    persisting_text: item.persisting_days > 1 ? `persisting ${item.persisting_days} days` : 'new today',
    confidence_text: `${Math.round((item.confidence || 0) * 100)}%`,
  }).trim();
  return {
    item_id: item.item_id,
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    metadata: {
      event_type: ITEM_EVENT,
      event_payload: { run_id: runId, item_id: item.item_id, project_url: item.project_url, metric: item.metric },
    },
  };
};

// Notes nobody could match to an item are surfaced in the thread so a human can clarify (US2 scenario 4).
const unmatchedReply = ({ unmatchedNotes, runId, date }) => {
  const notes = (unmatchedNotes || []).map((n) => (typeof n === 'string' ? n : n.note)).filter(Boolean);
  if (!notes.length) {
    return [];
  }
  const text = template('unmatched')({ count_text: String(notes.length), notes }).trim();
  return [{
    item_id: null,
    kind: 'unmatched_notes',
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    metadata: { event_type: BRIEF_EVENT, event_payload: { run_id: runId, date, kind: 'unmatched_notes' } },
  }];
};

const briefMetadata = ({ runId, date, kind }) => ({
  event_type: BRIEF_EVENT,
  event_payload: { run_id: runId, date, kind },
});

/**
 * Build the payload for a brief.
 * @param {object} options brief, items (ranked), links (Map item_id -> url), runId, date, audience, channel
 */
const buildPayload = ({
  brief, items = [], links = new Map(), runId, date, audience, channel = null, unmatchedNotes = [],
}) => {
  assertAudience(audience);
  const metadata = briefMetadata({ runId, date, kind: brief.kind });

  if (brief.kind === 'heartbeat' || brief.kind === 'failure') {
    const view = {
      headline: brief.headline,
      has_expected_load_notice: Boolean(brief.expected_load_notice),
      expected_load_notice: brief.expected_load_notice || '',
      has_trace: Boolean(brief.footer && brief.footer.trace_url),
      trace_url: brief.footer ? brief.footer.trace_url : null,
      cost_text: formatCost(brief.footer ? brief.footer.cost_usd : 0),
    };
    const text = truncate(template(brief.kind)(view).trim(), TEXT_MAX);
    return { run_id: runId, kind: brief.kind, parent: { channel, text, metadata }, image: null, replies: [] };
  }

  const text = truncate(template('parent')({
    headline: brief.headline,
    bullets: brief.bullets,
    has_expected_load_notice: Boolean(brief.expected_load_notice),
    expected_load_notice: brief.expected_load_notice || '',
    has_degradation_notice: Boolean(brief.degradation_notice),
    degradation_notice: brief.degradation_notice || '',
  }).trim(), TEXT_MAX);

  return {
    run_id: runId,
    kind: brief.kind,
    parent: { channel, text, blocks: parentBlocks(brief), unfurl_links: false, unfurl_media: false, metadata },
    image: {
      filename: `brief-${runId}.png`,
      alt_text: truncate(brief.headline, HEADER_MAX),
      path: brief.image ? brief.image.path : null,
      slack_file_id: brief.image ? brief.image.slack_file_id : null,
    },
    replies: [
      ...[...items].sort(rankOrder).map((item) => replyFor({ item, links, runId })),
      ...unmatchedReply({ unmatchedNotes, runId, date }),
    ],
  };
};

/** Return a copy of the payload with the uploaded file referenced by an image block after the bullets. */
const withImageBlock = (payload, fileId) => {
  const blocks = payload.parent.blocks.filter((block) => block.type !== 'image');
  const lastSection = blocks.map((block) => block.type).lastIndexOf('section');
  const insertAt = lastSection === -1 ? 1 : lastSection + 1;
  blocks.splice(insertAt, 0, imageBlock(fileId, payload.image ? payload.image.alt_text : ''));
  return {
    ...payload,
    parent: { ...payload.parent, blocks },
    image: payload.image ? { ...payload.image, slack_file_id: fileId } : null,
  };
};

module.exports = {
  buildPayload, withImageBlock, mrkdwn, link, footerText, BRIEF_EVENT, ITEM_EVENT, HEADER_MAX, TEXT_MAX,
};
