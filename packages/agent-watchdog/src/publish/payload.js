'use strict';
// The exact Slack payload (contracts/slack-payload.md): built by code, escaped through templates, and the
// same object whether previewed or posted (FR-019, FR-020, FR-025). No image since revision 24 (FR-023 retired).
const fs = require('node:fs');
const path = require('node:path');
const Handlebars = require('handlebars');
const { assertAudience } = require('./audience');
const { hostOf, plain } = require('../rollup/deterministic-brief');
const { headlineMarker, bulletMarker, noticeMarker, withMarker, MARKERS } = require('../rollup/markers');
const { formatCost } = require('./footer');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates', 'slack');
const HEADER_MAX = 150;
const TEXT_MAX = 4000;
const BRIEF_EVENT = 'agent_watchdog.brief';
const ITEM_EVENT = 'agent_watchdog.item';
const ALERTS_EVENT = 'agent_watchdog.alerts';
// An alert group's thread reply lists at most this many instances and the count of the rest (FR-066).
const MAX_ALERT_INSTANCES = 50;
// Thread replies are for body items only, highest rank first and at most this many (FR-020, revision 23); every item
// is in the report, shared into the thread, where a note can cite it by rank.
const MAX_ITEM_REPLIES = 25;
const SECTION_MAX = 3000;
// Alert replies are fitted into one section: instance counts tried in this order, pattern hosts named up to this.
const INSTANCE_STEPS = Object.freeze([MAX_ALERT_INSTANCES, 40, 30, 20, 15, 10, 5, 0]);
const MAX_PATTERN_HOSTS = 12;

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

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const footerText = (footer, { furtherItems = 0 } = {}) => {
  const parts = [link(footer.prompts_url, 'prompts'), link(footer.config_url, 'configuration')];
  if (footer.trace_url) {
    parts.push(link(footer.trace_url, 'trace'));
  }
  parts.push(`cost ${formatCost(footer.cost_usd)}`);
  if (furtherItems > 0) {
    parts.push(`${plural(furtherItems, 'more item')} in the report (thread)`);
  }
  return parts.join(' · ');
};

const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

// Slack mrkdwn has no nested lists: sub-bullets are indented lines inside their bullet's section (smoke S-16).
const SUB_BULLET_PREFIX = '   ◦ ';

// Markers (FR-082) are added when the payload renders; the stored brief keeps plain text.
const markedBullet = (bullet, severityOf) => withMarker(bulletMarker(bullet, severityOf), bullet.text);
const markedNotice = (notice) => withMarker(noticeMarker(notice), notice);

const bulletText = (bullet, severityOf) => [
  mrkdwn(markedBullet(bullet, severityOf)),
  ...(bullet.children || []).map((child) => `${SUB_BULLET_PREFIX}${mrkdwn(child.text)}`),
].join('\n');

const parentBlocks = (brief, severityOf, { furtherItems = 0 } = {}) => {
  const headline = withMarker(headlineMarker(brief), brief.headline);
  const headerText = { type: 'plain_text', text: truncate(headline, HEADER_MAX), emoji: true };
  const blocks = [{ type: 'header', text: headerText }];
  for (const bullet of brief.bullets) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: bulletText(bullet, severityOf) } });
  }
  if (brief.expected_load_notice) {
    blocks.push(context(`_${mrkdwn(withMarker(MARKERS.expectedLoad, brief.expected_load_notice))}_`));
  }
  if (brief.degradation_notice) {
    blocks.push(context(`_${mrkdwn(withMarker(MARKERS.warning, brief.degradation_notice))}_`));
  }
  for (const notice of brief.notices || []) {
    blocks.push(context(`_${mrkdwn(markedNotice(notice))}_`));
  }
  blocks.push(context(footerText(brief.footer, { furtherItems })));
  return blocks;
};

const rankOrder = (a, b) => {
  const ra = a.rank === null || a.rank === undefined ? Number.MAX_SAFE_INTEGER : a.rank;
  const rb = b.rank === null || b.rank === undefined ? Number.MAX_SAFE_INTEGER : b.rank;
  return ra - rb || a.item_id.localeCompare(b.item_id);
};

/** The report's entry on the payload: the file to share into the thread and its code-built comment, or null. */
const reportEntry = ({ brief, runId, ranked, replied }) => {
  if (!brief.report || !brief.report.path) {
    return null;
  }
  const withoutReply = new Set(replied.map((item) => item.item_id));
  const example = ranked
    .find((item) => !withoutReply.has(item.item_id) && item.rank !== null && item.rank !== undefined);
  return {
    filename: `report-${runId}.html`,
    title: `Watchdog report ${runId}`,
    path: brief.report.path,
    items: ranked.length,
    replied: replied.length,
    initial_comment: reportComment({
      items: ranked.length, replied: replied.length, exampleRank: example ? example.rank : null,
    }),
    slack_file_id: brief.report.slack_file_id || null,
    ts: brief.report.ts || null,
  };
};

/** The firing alert whose category covers an item's metric, as a line for the item's reply (FR-079). */
const alertLineFor = ({ item, alertGroups, alertCategories }) => {
  const host = hostOf(item.project_url);
  const matching = alertGroups.flatMap((group) => (group.instances || [])
    .filter((instance) => instance.host === host)
    .filter(() => (alertCategories[group.category] || []).some((name) => String(item.metric).includes(name))));
  if (!matching.length) {
    return null;
  }
  const [first] = matching;
  const rest = matching.length > 1 ? `, +${matching.length - 1} more` : '';
  return withMarker(MARKERS.alerts,
    `Alert firing: ${first.title} since ${String(first.started_at).slice(0, 10)} (${first.days_firing}d)${rest}`);
};

const rankOf = (item) => (item.rank === null || item.rank === undefined ? Number.MAX_SAFE_INTEGER : item.rank);

const relationText = (relation) => String(relation || '').replace(/_/g, ' ');

/** The lower-ranked items that relate to this one (FR-009, revision 23), as lines for its reply. */
const relatedLinesFor = (item, items) => items
  .filter((other) => other.relates_to && other.relates_to.item_id === item.item_id && rankOf(other) > rankOf(item))
  .sort(rankOrder)
  .map((other) => ({
    text: `Related: \`${other.metric}\` (${relationText(other.relates_to.relation)}) #${other.rank}`,
  }));

/**
 * The comment on the report's thread share (FR-022, revision 23): what it holds and how to cite an item in a note.
 * `exampleRank` is the first item without a reply, so the example is an item the reader can only find there.
 */
const reportComment = ({ items, replied, exampleRank = null }) => {
  const cite = exampleRank === null
    ? 'its number in the report'
    : `its number in the report (e.g. #${exampleRank})`;
  return `Full report: ${plural(items, 'item')}, ${replied} with a reply in this thread. To comment on an item, reply `
    + `here citing ${cite} or its host and metric; a 👍 or 👎 in your reply is its verdict.`;
};

const replyFor = ({ item, links, runId, alertLine = null, related = [] }) => {
  const url = links.get(item.item_id) || null;
  const text = template('reply')({
    related,
    severity_label: item.severity.toUpperCase(),
    host: hostOf(item.project_url),
    metric: item.metric,
    why_now: item.why_now,
    suggested_check: item.suggested_check,
    has_link: Boolean(url),
    link_url: url,
    has_alert: Boolean(alertLine),
    alert_text: alertLine || '',
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

// Thousands are grouped for the reader; the gate's number matching works on the stored data, not on this text.
const grouped = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(plain(value)));

/** The metric next to an alert instance (FR-079): its current value and yesterday's, code-formatted. */
const evidenceText = (evidence) => {
  if (!evidence || evidence.current_value === null || evidence.current_value === undefined) {
    return '';
  }
  const perDay = evidence.aggregate === 'increase' ? '/day' : '';
  const yesterday = evidence.previous_day_value === null || evidence.previous_day_value === undefined
    ? ''
    : ` (yesterday ${grouped(evidence.previous_day_value)}${perDay})`;
  return ` · ${evidence.metric} ${grouped(evidence.current_value)}${perDay} now${yesterday}`;
};

/**
 * One thread reply per Alert Group (FR-066): programme-wide patterns as one paragraph each (FR-078), the other
 * instances oldest first with their metric (FR-079), the rest counted, code-built links.
 */
const hostList = (hosts, max) => (hosts.length <= max
  ? hosts.join(', ')
  : `${hosts.slice(0, max).join(', ')}, +${hosts.length - max} more`);

const alertReplyFor = ({ group, links, runId, date, staleAfterDays }) => {
  const patterns = group.patterns || [];
  const inPattern = new Set(patterns.flatMap((p) => p.instance_ids || []));
  const members = (group.instances || []).filter((instance) => !inPattern.has(instance.instance_id));
  const fullLinks = links
    ? [
      { url: links.group, label: `all firing ${group.category} alerts for ${group.group}` },
      ...(links.rules || []).map((rule) => ({ url: rule.url, label: rule.title })),
    ]
    : [];
  const short = (links && links.short) || null;
  let shortLinks = [];
  if (short && (short.rules || []).length) {
    shortLinks = short.rules.map((rule) => ({ url: rule.url, label: `${rule.title} (all projects)` }));
  } else if (short && short.group) {
    shortLinks = [{ url: short.group, label: 'all firing alerts' }];
  }
  const render = ({ instanceMax, hostMax, linkList }) => {
    const shown = members.slice(0, instanceMax);
    const rest = members.length - shown.length;
    return template('alert-group')({
      group: group.group,
      category: group.category,
      importance_label: String(group.importance || 'medium').toUpperCase(),
      summary_text: `${group.firing} firing, ${group.stale} stale for more than ${staleAfterDays} days, `
        + `${group.new} new since the previous run`,
      patterns: patterns.map((p) => ({
        text: withMarker(MARKERS.pattern,
          `Programme-wide: ${p.title} on ${p.count} of ${p.of} projects, first ${p.since_min}, last ${p.since_max}`),
        hosts: hostList(p.hosts || [], hostMax),
      })),
      instances: shown.map((instance) => ({
        title: instance.title,
        host: instance.host || 'watchdog',
        since_text: `${String(instance.started_at).slice(0, 10)} (${instance.days_firing}d)`,
        stale: Boolean(instance.stale),
        new: Boolean(instance.new),
        evidence_text: evidenceText(instance.evidence),
      })),
      has_rest: rest > 0,
      rest_text: `${rest} more`,
      links: linkList,
    }).trim();
  };
  // One section block, never a link cut in two (revision 17): keep as many instances as possible; for each count
  // try the filtered links, then the group link alone, then the links without the host filter, each with every
  // pattern host named before the host list is elided.
  let text = null;
  const variants = [fullLinks, fullLinks.slice(0, 1), shortLinks];
  for (const instanceMax of INSTANCE_STEPS) {
    for (const linkList of variants) {
      for (const hostMax of [Infinity, MAX_PATTERN_HOSTS]) {
        const candidate = render({ instanceMax, hostMax, linkList });
        if (text === null && candidate.length <= SECTION_MAX) {
          text = candidate;
        }
      }
    }
    if (text !== null) {
      break;
    }
  }
  if (text === null) {
    // Nothing fits even bare: keep the links whole and cut the body in front of them.
    const linksText = shortLinks.map((l) => link(l.url, l.label)).join('\n');
    const body = render({ instanceMax: 0, hostMax: MAX_PATTERN_HOSTS, linkList: [] });
    const room = Math.max(0, SECTION_MAX - linksText.length - 1);
    text = `${truncate(body, room)}\n${linksText}`.trim();
  }
  return {
    alert_key: group.alert_key,
    item_id: null,
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
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
 *   alertGroups (in body order) with alertLinks (Map alert_key -> { group, rules, all }) and staleAfterDays (US8);
 *   layout (rollup/layout.json) whose body_items select the items that get a reply (FR-020, revision 23); without
 *   one, every item not placed in the thread does
 */
const buildPayload = ({
  brief, items = [], links = new Map(), runId, date, audience, channel = null, digest = null, alertGroups = [],
  alertLinks = new Map(), staleAfterDays = 14, alertCategories = {}, layout = null,
}) => {
  assertAudience(audience);
  const metadata = briefMetadata({ runId, date, kind: brief.kind });
  const severityById = new Map(items.map((item) => [item.item_id, item.severity]));
  const severityOf = (id) => severityById.get(id) || null;

  if (brief.kind === 'heartbeat' || brief.kind === 'failure') {
    const view = {
      headline: withMarker(headlineMarker(brief), brief.headline),
      has_expected_load_notice: Boolean(brief.expected_load_notice),
      expected_load_notice: brief.expected_load_notice || '',
      has_trace: Boolean(brief.footer && brief.footer.trace_url),
      trace_url: brief.footer ? brief.footer.trace_url : null,
      has_notices: Boolean(brief.notices && brief.notices.length),
      notices_text: (brief.notices || []).map(markedNotice).join(' · '),
      cost_text: formatCost(brief.footer ? brief.footer.cost_usd : 0),
    };
    const text = truncate(template(brief.kind)(view).trim(), TEXT_MAX);
    return {
      run_id: runId, kind: brief.kind, parent: { channel, text, metadata }, image: null, report: null, replies: [],
      digest: digestField(digest),
    };
  }

  const bodyIds = layout && Array.isArray(layout.body_items) ? new Set(layout.body_items) : null;
  const isBody = (item) => (bodyIds ? bodyIds.has(item.item_id) : item.placement !== 'thread');
  const ranked = [...items].sort(rankOrder);
  const replied = ranked.filter(isBody).slice(0, MAX_ITEM_REPLIES);
  const furtherItems = ranked.length - replied.length;

  const text = truncate(template('parent')({
    headline: withMarker(headlineMarker(brief), brief.headline),
    bullets: brief.bullets.map((bullet) => ({
      text: markedBullet(bullet, severityOf), children: bullet.children || [],
    })),
    has_expected_load_notice: Boolean(brief.expected_load_notice),
    expected_load_notice: brief.expected_load_notice
      ? withMarker(MARKERS.expectedLoad, brief.expected_load_notice)
      : '',
    has_degradation_notice: Boolean(brief.degradation_notice),
    degradation_notice: brief.degradation_notice ? withMarker(MARKERS.warning, brief.degradation_notice) : '',
    notices: (brief.notices || []).map(markedNotice),
  }).trim(), TEXT_MAX);

  return {
    run_id: runId,
    kind: brief.kind,
    parent: {
      channel,
      text,
      blocks: parentBlocks(brief, severityOf, { furtherItems }),
      unfurl_links: false,
      unfurl_media: false,
      metadata,
    },
    // The brief image was a capture of the message itself and is retired (revision 24); the field stays null so a
    // stored payload keeps its shape. The report, shared into the thread, is the document a reader opens.
    image: null,
    report: reportEntry({ brief, runId, ranked, replied }),
    replies: [
      ...replied.map((item) => replyFor({
        item, links, runId, alertLine: alertLineFor({ item, alertGroups, alertCategories }),
        related: relatedLinesFor(item, ranked),
      })),
      ...alertGroups.map((group) => alertReplyFor({
        group, links: linksFor(alertLinks, group.alert_key), runId, date, staleAfterDays,
      })),
    ],
    digest: digestField(digest),
  };
};

module.exports = {
  buildPayload, alertReplyFor, reportComment, mrkdwn, link, footerText, BRIEF_EVENT, ITEM_EVENT,
  ALERTS_EVENT, HEADER_MAX, TEXT_MAX, SUB_BULLET_PREFIX, MAX_ALERT_INSTANCES, MAX_ITEM_REPLIES,
};
