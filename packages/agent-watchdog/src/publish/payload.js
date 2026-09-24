'use strict';
// The exact Slack payload (contracts/slack-payload.md): built by code, escaped through templates, and the same object
// whether previewed or posted (FR-019, FR-020, FR-025, FR-066). Revision 28: the headline whole in a bold section, at
// most two programme bullets, and a thread of programme replies, one Other reply and one alerts reply.
const fs = require('node:fs');
const path = require('node:path');
const Handlebars = require('handlebars');
const { assertAudience } = require('./audience');
const { headlineMarker, bulletMarker, noticeMarker, withMarker, MARKERS } = require('../rollup/markers');
const { replyKindOf } = require('../rollup/layout');
const { formatCost } = require('./footer');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates', 'slack');
const TEXT_MAX = 4000;
const SECTION_MAX = 3000;
const BRIEF_EVENT = 'agent_watchdog.brief';
const PROGRAMME_EVENT = 'agent_watchdog.programme';
const ALERTS_EVENT = 'agent_watchdog.alerts';
// Code-added notices that are about alerts close the alerts reply rather than the post body (FR-066, FR-080).
const ALERT_NOTICE_PREFIXES = Object.freeze([
  'Housekeeping:', 'Resolved since the previous run:', 'Alerts unavailable:',
]);

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

const isAlertNotice = (notice) => ALERT_NOTICE_PREFIXES.some((prefix) => String(notice || '').startsWith(prefix));

/**
 * The one footer line of the post and the report (FR-019, revision 25): specification, configuration and trace links,
 * the cost, the run id; the post adds how many items are only in the report.
 */
const footerText = (footer, { runId = null, furtherItems = 0 } = {}) => {
  const parts = [link(footer.specs_url, 'specs'), link(footer.config_url, 'configuration')];
  if (footer.trace_url) {
    parts.push(link(footer.trace_url, 'trace'));
  }
  parts.push(`cost ${formatCost(footer.cost_usd)}`);
  if (runId) {
    parts.push(`run ${runId}`);
  }
  if (furtherItems > 0) {
    parts.push(`${plural(furtherItems, 'more item')} in the report (thread)`);
  }
  return parts.join(' · ');
};

const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });

// Slack mrkdwn has no nested lists: sub-bullets are indented lines inside their bullet's section (smoke S-16).
const SUB_BULLET_PREFIX = '   ◦ ';

// Markers (FR-082) are added when the payload renders; the stored brief keeps plain text.
const markedBullet = (bullet, severityOf) => withMarker(bulletMarker(bullet, severityOf), bullet.text);
const markedNotice = (notice) => withMarker(noticeMarker(notice), notice);

const bulletText = (bullet, severityOf) => [
  mrkdwn(markedBullet(bullet, severityOf)),
  ...(bullet.children || []).map((child) => `${SUB_BULLET_PREFIX}${mrkdwn(child.text)}`),
].join('\n');

const bodyNotices = (brief) => (brief.notices || []).filter((notice) => !isAlertNotice(notice));

const parentBlocks = (brief, severityOf, { runId = null, furtherItems = 0 } = {}) => {
  // A bold section, never Slack's `header` block, which cuts text at 150 characters (FR-019, revision 28).
  const blocks = [section(`*${mrkdwn(withMarker(headlineMarker(brief), brief.headline))}*`)];
  for (const bullet of brief.bullets) {
    blocks.push(section(bulletText(bullet, severityOf)));
  }
  if (brief.expected_load_notice) {
    blocks.push(context(`_${mrkdwn(withMarker(MARKERS.expectedLoad, brief.expected_load_notice))}_`));
  }
  if (brief.degradation_notice) {
    blocks.push(context(`_${mrkdwn(withMarker(MARKERS.warning, brief.degradation_notice))}_`));
  }
  for (const notice of bodyNotices(brief)) {
    blocks.push(context(`_${mrkdwn(markedNotice(notice))}_`));
  }
  blocks.push(context(footerText(brief.footer, { runId, furtherItems })));
  return blocks;
};

const rankOrder = (a, b) => {
  const ra = a.rank === null || a.rank === undefined ? Number.MAX_SAFE_INTEGER : a.rank;
  const rb = b.rank === null || b.rank === undefined ? Number.MAX_SAFE_INTEGER : b.rank;
  return ra - rb || a.item_id.localeCompare(b.item_id);
};

/**
 * The comment on the report's thread share (FR-022, revisions 23 and 28): what it holds and how to cite an item in a
 * note. `exampleRank` is the first item outside the body, so the example is an item the reader can only find there.
 */
const reportComment = ({ items, exampleRank = null }) => {
  const cite = exampleRank === null
    ? 'its number in the report'
    : `its number in the report (e.g. #${exampleRank})`;
  return `Full report: ${plural(items, 'item')}. To comment on an item, reply here citing ${cite} or its host and `
    + 'metric; a 👍 or 👎 in your reply is its verdict.';
};

/** The report's entry on the payload: the file to share into the thread and its code-built comment, or null. */
const reportEntry = ({ brief, runId, ranked, bodyIds }) => {
  if (!brief.report || !brief.report.path) {
    return null;
  }
  const example = ranked.find((item) => !bodyIds.has(item.item_id) && item.rank !== null && item.rank !== undefined);
  return {
    filename: `report-${runId}.html`,
    title: `Watchdog report ${runId}`,
    path: brief.report.path,
    items: ranked.length,
    initial_comment: reportComment({ items: ranked.length, exampleRank: example ? example.rank : null }),
    slack_file_id: brief.report.slack_file_id || null,
    ts: brief.report.ts || null,
  };
};

// A line's items: the ids it covers (revision 28), or its own item for a line stored before that.
const idsOfLine = (line) => (line.item_ids && line.item_ids.length ? line.item_ids : [line.item_id].filter(Boolean));

/** The items a bullet's lines cover: its own for an item bullet, its children's for a group. */
const coveredByBullet = (bullet) => [
  ...idsOfLine(bullet),
  ...(bullet.children || []).flatMap(idsOfLine),
];

/**
 * One thread reply per thread bullet (FR-020, revision 28): a programme not in the body, or the Other reply, in the
 * body's form, with the items it covers in its metadata.
 */
const programmeReplyFor = ({ bullet, runId, date, severityOf }) => {
  const kind = replyKindOf(bullet);
  const text = truncate(template('programme')({
    text: markedBullet(bullet, severityOf),
    children: bullet.children || [],
  }).trim(), SECTION_MAX);
  return {
    kind,
    group: bullet.group,
    item_id: null,
    alert_key: null,
    text,
    blocks: [section(text)],
    metadata: {
      event_type: PROGRAMME_EVENT,
      event_payload: { run_id: runId, date, group: bullet.group, kind, item_ids: coveredByBullet(bullet) },
    },
  };
};

/**
 * The firing alerts per programme (FR-066, revision 28): the firing count with its categories, the new and stale
 * counts, largest programme first; the instances themselves are in the report.
 */
const alertsSummary = (alertGroups) => {
  const byGroup = new Map();
  for (const group of alertGroups || []) {
    const label = group.group || 'Other';
    if (!byGroup.has(label)) {
      byGroup.set(label, { group: label, firing: 0, new: 0, stale: 0, categories: [] });
    }
    const entry = byGroup.get(label);
    entry.firing += group.firing || 0;
    entry.new += group.new || 0;
    entry.stale += group.stale || 0;
    entry.categories.push({ category: group.category, firing: group.firing || 0 });
  }
  return [...byGroup.values()]
    .map((entry) => ({
      ...entry,
      categories: [...entry.categories].sort((a, b) => b.firing - a.firing || a.category.localeCompare(b.category)),
    }))
    .sort((a, b) => b.firing - a.firing || a.group.localeCompare(b.group));
};

const alertsLine = (entry) => {
  const categories = entry.categories.map((c) => `${String(c.category).replace(/_/g, ' ')} ${c.firing}`).join(', ');
  return `${entry.group}: ${entry.firing} firing (${categories}), ${entry.new} new, ${entry.stale} stale`;
};

/**
 * Fit the alerts reply into one section without cutting a link (revision 34): whole programme lines go first, from
 * the end, with a line saying how many more the report holds; then the notices, then the link to every alert.
 * What remains, the summary line and at least one programme, is never longer than the section allows.
 */
const fitAlertsText = (render, { programmes, notices }) => {
  const attempts = [];
  for (let shown = programmes; shown >= Math.min(1, programmes); shown -= 1) {
    attempts.push({ shown, notices, withAll: true });
  }
  attempts.push({ shown: Math.min(1, programmes), notices: [], withAll: true });
  attempts.push({ shown: Math.min(1, programmes), notices: [], withAll: false });
  attempts.push({ shown: 0, notices: [], withAll: false });
  let last = null;
  for (const attempt of attempts) {
    last = render(attempt);
    if (last.length <= SECTION_MAX) {
      return last;
    }
  }
  return truncate(last, SECTION_MAX);
};

/**
 * The one alerts reply (FR-066, FR-080, revision 28): per programme its counts and the link to its filtered alert
 * list, one link to every firing alert, then the alert-derived notices. Null when there is nothing to say.
 */
const alertsReplyFor = ({ alertGroups, alertsLinks, notices, runId, date }) => {
  const summary = alertsSummary(alertGroups);
  const alertNotices = (notices || []).filter(isAlertNotice).map(markedNotice);
  if (!summary.length && !alertNotices.length) {
    return null;
  }
  const byGroup = alertsLinks && alertsLinks.byGroup ? alertsLinks.byGroup : new Map();
  const linkFor = (label) => (byGroup instanceof Map ? byGroup.get(label) : byGroup[label]) || null;
  const firing = summary.reduce((sum, entry) => sum + entry.firing, 0);
  const summaryText = summary.length
    ? `${firing} firing across ${plural(summary.length, 'programme')}`
    : 'none firing';
  const programmes = summary.map((entry) => ({
    line: alertsLine(entry), has_link: Boolean(linkFor(entry.group)), link: linkFor(entry.group),
  }));
  const render = ({ shown, notices: shownNotices, withAll }) => template('alerts')({
    summary_text: summaryText,
    programmes: programmes.slice(0, shown),
    has_rest: shown < programmes.length,
    rest_text: `+${programmes.length - shown} more programmes in the report`,
    has_all: withAll && Boolean(alertsLinks && alertsLinks.all && summary.length),
    all: alertsLinks ? alertsLinks.all : null,
    notices: shownNotices,
  }).trim();
  const text = fitAlertsText(render, { programmes: programmes.length, notices: alertNotices });
  return {
    kind: 'alerts',
    group: null,
    item_id: null,
    alert_key: null,
    text,
    blocks: [section(text)],
    metadata: {
      event_type: ALERTS_EVENT,
      event_payload: { run_id: runId, date, firing, programmes: summary.map((entry) => entry.group) },
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
 * @param {object} options brief (with `thread`), items (ranked), runId, date, audience, channel, digest (from
 *   buildDigest, or null), alertGroups (the groups the roll-up briefed) and alertsLinks ({ byGroup: Map label -> url,
 *   all: url }) from src/links/build.js
 */
const buildPayload = ({
  brief, items = [], runId, date, audience, channel = null, digest = null, alertGroups = [],
  alertsLinks = { byGroup: new Map(), all: null },
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

  const ranked = [...items].sort(rankOrder);
  const bodyIds = new Set(brief.bullets.flatMap(coveredByBullet));
  const furtherItems = ranked.filter((item) => !bodyIds.has(item.item_id)).length;

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
    notices: bodyNotices(brief).map(markedNotice),
  }).trim(), TEXT_MAX);

  const alertsReply = alertsReplyFor({ alertGroups, alertsLinks, notices: brief.notices, runId, date });
  return {
    run_id: runId,
    kind: brief.kind,
    parent: {
      channel,
      text,
      blocks: parentBlocks(brief, severityOf, { runId, furtherItems }),
      unfurl_links: false,
      unfurl_media: false,
      metadata,
    },
    // The brief image was a capture of the message itself and is retired (revision 24); the field stays null so a
    // stored payload keeps its shape. The report, shared into the thread, is the document a reader opens.
    image: null,
    report: reportEntry({ brief, runId, ranked, bodyIds }),
    replies: [
      ...(brief.thread || []).map((bullet) => programmeReplyFor({ bullet, runId, date, severityOf })),
      ...(alertsReply ? [alertsReply] : []),
    ],
    digest: digestField(digest),
  };
};

module.exports = {
  buildPayload, reportComment, alertsSummary, alertsReplyFor, programmeReplyFor, isAlertNotice, mrkdwn, link,
  footerText, BRIEF_EVENT, PROGRAMME_EVENT, ALERTS_EVENT, TEXT_MAX, SECTION_MAX, SUB_BULLET_PREFIX,
  ALERT_NOTICE_PREFIXES,
};
