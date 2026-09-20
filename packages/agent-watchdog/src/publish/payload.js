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
const ALERTS_EVENT = 'agent_watchdog.alerts';
// An alert group's thread reply lists at most this many instances and the count of the rest (FR-066).
const MAX_ALERT_INSTANCES = 50;
const SECTION_MAX = 3000;

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

// Slack mrkdwn has no nested lists: sub-bullets are indented lines inside their bullet's section (smoke S-16).
const SUB_BULLET_PREFIX = '   ◦ ';

const bulletText = (bullet) => [
  mrkdwn(bullet.text),
  ...(bullet.children || []).map((child) => `${SUB_BULLET_PREFIX}${mrkdwn(child.text)}`),
].join('\n');

const parentBlocks = (brief) => {
  const headerText = { type: 'plain_text', text: truncate(brief.headline, HEADER_MAX), emoji: true };
  const blocks = [{ type: 'header', text: headerText }];
  for (const bullet of brief.bullets) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: bulletText(bullet) } });
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
  for (const notice of brief.notices || []) {
    blocks.push(context(`_${mrkdwn(notice)}_`));
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

const linksFor = (alertLinks, key) => {
  if (!alertLinks) {
    return null;
  }
  return alertLinks instanceof Map ? alertLinks.get(key) || null : alertLinks[key] || null;
};

/** One thread reply per Alert Group (FR-066): its instances oldest first, the rest counted, code-built links. */
const alertReplyFor = ({ group, links, runId, date, staleAfterDays }) => {
  const members = group.instances || [];
  const shown = members.slice(0, MAX_ALERT_INSTANCES);
  const rest = members.length - shown.length;
  const linkList = links
    ? [
      { url: links.group, label: `all firing ${group.category} alerts for ${group.group}` },
      ...(links.rules || []).map((rule) => ({ url: rule.url, label: rule.title })),
    ]
    : [];
  const text = truncate(template('alert-group')({
    group: group.group,
    category: group.category,
    importance_label: String(group.importance || 'medium').toUpperCase(),
    summary_text: `${group.firing} firing, ${group.stale} stale for more than ${staleAfterDays} days, `
      + `${group.new} new since the previous run`,
    instances: shown.map((instance) => ({
      title: instance.title,
      host: instance.host || 'watchdog',
      since_text: `${String(instance.started_at).slice(0, 10)} (${instance.days_firing}d)`,
      stale: Boolean(instance.stale),
      new: Boolean(instance.new),
    })),
    has_rest: rest > 0,
    rest_text: `${rest} more`,
    links: linkList,
  }).trim(), TEXT_MAX);
  return {
    alert_key: group.alert_key,
    item_id: null,
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: truncate(text, SECTION_MAX) } }],
    metadata: {
      event_type: ALERTS_EVENT,
      event_payload: { run_id: runId, date, group: group.group, category: group.category, firing: group.firing },
    },
  };
};

// The feedback digest (FR-062) is built by src/publish/digest.js and carried on the payload as posted:
// its text, blocks and metadata, the record ids it acknowledges, and the reactions added after posting.
const digestField = (built) => (built
  ? {
    text: built.text, blocks: built.blocks, metadata: built.metadata,
    acknowledged: [...built.digest.acknowledged], reactions: [],
  }
  : null);

const briefMetadata = ({ runId, date, kind }) => ({
  event_type: BRIEF_EVENT,
  event_payload: { run_id: runId, date, kind },
});

/**
 * Build the payload for a brief.
 * @param {object} options brief, items (ranked), links (Map item_id -> url), runId, date, audience, channel,
 *   digest (from buildDigest, or null); unmatched notes travel inside the digest since User Story 7;
 *   alertGroups (in body order) with alertLinks (Map alert_key -> { group, rules, all }) and staleAfterDays (US8)
 */
const buildPayload = ({
  brief, items = [], links = new Map(), runId, date, audience, channel = null, digest = null, alertGroups = [],
  alertLinks = new Map(), staleAfterDays = 14,
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
      has_notices: Boolean(brief.notices && brief.notices.length),
      notices_text: (brief.notices || []).join(' · '),
      cost_text: formatCost(brief.footer ? brief.footer.cost_usd : 0),
    };
    const text = truncate(template(brief.kind)(view).trim(), TEXT_MAX);
    return {
      run_id: runId, kind: brief.kind, parent: { channel, text, metadata }, image: null, replies: [],
      digest: digestField(digest),
    };
  }

  const text = truncate(template('parent')({
    headline: brief.headline,
    bullets: brief.bullets.map((bullet) => ({ text: bullet.text, children: bullet.children || [] })),
    has_expected_load_notice: Boolean(brief.expected_load_notice),
    expected_load_notice: brief.expected_load_notice || '',
    has_degradation_notice: Boolean(brief.degradation_notice),
    degradation_notice: brief.degradation_notice || '',
    notices: brief.notices || [],
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
      ...alertGroups.map((group) => alertReplyFor({
        group, links: linksFor(alertLinks, group.alert_key), runId, date, staleAfterDays,
      })),
    ],
    digest: digestField(digest),
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
  buildPayload, withImageBlock, alertReplyFor, mrkdwn, link, footerText, BRIEF_EVENT, ITEM_EVENT, ALERTS_EVENT,
  HEADER_MAX, TEXT_MAX, SUB_BULLET_PREFIX, MAX_ALERT_INSTANCES,
};
