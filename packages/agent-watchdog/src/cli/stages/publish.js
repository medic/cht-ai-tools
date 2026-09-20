'use strict';
// Stage: publish. Builds the exact payload, writes it, and posts it unless the run is a preview (FR-019, FR-025).
const { requireInputs } = require('./index');
const { buildPayload } = require('../../publish/payload');
const { createSlackPublisher } = require('../../publish/slack');
const { buildDigest } = require('../../publish/digest');
const { readUnacknowledged, markAcknowledged, feedbackFile } = require('../../feedback/store');
const { buildAlertGroupLinks } = require('../../links/build');

const name = 'publish';
const inputs = ['rollup/brief.json'];

const slackClient = (ctx) => {
  if (ctx.deps && ctx.deps.slack) {
    return ctx.deps.slack;
  }
  const { WebClient } = require('@slack/web-api');
  return new WebClient(ctx.config.secrets.slackBotToken);
};

const DEFAULT_INFLUENCE_DAYS = 30;

const lookup = (byItem, itemId) => {
  if (!byItem) {
    return undefined;
  }
  return byItem instanceof Map ? byItem.get(itemId) : byItem[itemId];
};

/**
 * What feedback did to each ranked item's confidence, as a direction plus the confidence it now has. The
 * ranked items already carry the adjusted value (src/rollup/rank.js), so no "before" is invented here.
 */
const adjustmentsFor = (items, byItem) => items.map((item) => {
  const entry = lookup(byItem, item.item_id);
  if (!entry) {
    return null;
  }
  const net = (entry.up || 0) - (entry.down || 0);
  let direction = null;
  if (entry.verdict === 'confirmed' && net > 0) {
    direction = 'up';
  } else if (entry.verdict === 'dismissed' && net < 0) {
    direction = 'down';
  }
  return direction ? { item_id: item.item_id, direction, after: item.confidence } : null;
}).filter(Boolean);

const suppressedFor = async (runDir, discovery) => {
  const out = [];
  for (const project of (discovery && discovery.projects) || []) {
    const rel = `${project.slug}/suppressed.json`;
    if (runDir.exists(rel)) {
      const entries = await runDir.readJson(rel);
      out.push(...(Array.isArray(entries) ? entries : []));
    }
  }
  return out;
};

/** Alert Groups in body order (the layout's body alerts, then the thread's), or none when alerting was unavailable. */
const orderedAlertGroups = (classified, layout) => {
  if (!classified || !classified.available) {
    return [];
  }
  const byKey = new Map((classified.groups || []).map((group) => [group.alert_key, group]));
  const order = layout ? [...(layout.body_alerts || []), ...(layout.thread_alerts || [])] : [...byKey.keys()];
  return order.map((key) => byKey.get(key)).filter(Boolean);
};

/** The digest input the feedback stage left for this run, read defensively: nothing there means nothing new. */
const feedbackInputs = async (ctx, runDir) => {
  if (ctx.feedbackIngested) {
    return ctx.feedbackIngested;
  }
  return runDir.exists('feedback.ingested.json') ? runDir.readJson('feedback.ingested.json') : null;
};

const run = async (ctx) => {
  const { runDir, logger } = ctx;
  requireInputs(runDir, inputs);
  const brief = await runDir.readJson('rollup/brief.json');
  const items = runDir.exists('rollup/items.ranked.json') ? await runDir.readJson('rollup/items.ranked.json') : [];
  const discovery = runDir.exists('discovery.json') ? await runDir.readJson('discovery.json') : null;
  const links = ctx.links && discovery
    ? ctx.links.buildItemLinks(items, discovery, ctx.config.endpoints.grafanaUrl)
    : new Map();
  const channel = ctx.config.endpoints.slackChannelId || null;

  // The feedback digest (FR-062): every record no earlier digest acknowledged, what it changed today, the
  // proposals written from it, and the retention statement. Nothing new means no digest.
  const dataDir = (ctx.config.storage && ctx.config.storage.dataDir) || runDir.dataDir;
  const ingested = await feedbackInputs(ctx, runDir);
  const unacknowledged = await readUnacknowledged(dataDir);
  const byItem = ctx.feedbackByItem || (ingested && ingested.by_item) || {};
  const influenceDays = (ctx.config.behaviour && ctx.config.behaviour.feedbackInfluenceDays)
    || (ingested && ingested.influence && ingested.influence.days)
    || DEFAULT_INFLUENCE_DAYS;
  const built = buildDigest({
    runId: ctx.runId,
    date: ctx.date,
    records: unacknowledged,
    byItem,
    items,
    adjustments: adjustmentsFor(items, byItem),
    suppressed: await suppressedFor(runDir, discovery),
    review: ingested ? ingested.review : null,
    unmatched: (ingested && ingested.unmatched) || ctx.feedbackUnmatched || [],
    retention: {
      records_path: (ingested && ingested.records_path) || feedbackFile(dataDir), influence_days: influenceDays,
    },
  });

  const classified = runDir.exists('alerts.classified.json') ? await runDir.readJson('alerts.classified.json') : null;
  const layout = runDir.exists('rollup/layout.json') ? await runDir.readJson('rollup/layout.json') : null;
  const alertGroups = orderedAlertGroups(classified, layout);
  const grafanaUrl = ctx.config.endpoints && ctx.config.endpoints.grafanaUrl;
  const alertLinks = new Map(alertGroups
    .map((group) => [group.alert_key, grafanaUrl ? buildAlertGroupLinks({ grafanaUrl, group }) : null]));

  const payload = buildPayload({
    brief,
    items,
    links,
    runId: ctx.runId,
    date: ctx.date,
    audience: 'internal',
    channel,
    digest: built,
    alertGroups,
    alertLinks,
    staleAfterDays: (classified && classified.stale_after_days) || 14,
  });
  await runDir.writeJson('rollup/payload.json', payload);
  if (built) {
    await runDir.writeJson('rollup/feedback.digest.json', built.digest);
    logger.info('publish.digest_built', {
      acknowledged: built.digest.acknowledged.length, items: built.digest.items.length,
      proposals: built.digest.proposals.length, unclassified: built.digest.unclassified,
    });
  }

  if (ctx.mode === 'preview') {
    logger.info('publish.preview', { kind: brief.kind, replies: payload.replies.length, digest: Boolean(built) });
    return { posted: false, payload };
  }

  const publisher = createSlackPublisher({ client: slackClient(ctx), channel, logger });
  let publication;
  if (brief.kind === 'heartbeat' || brief.kind === 'failure') {
    publication = await publisher.postTextOnly(payload);
  } else {
    const imagePath = brief.image && brief.image.path ? runDir.path(brief.image.path) : null;
    publication = await publisher.publish({ payload, imagePath, superseded: ctx.supersededPermalink || null });
  }
  if (built) {
    // Digest last, under today's parent; acknowledge only once the digest is out, then the courtesy reactions.
    const digestPublication = await publisher.postDigest({ digest: payload.digest, parentTs: publication.ts });
    const marked = await markAcknowledged(dataDir, built.digest.acknowledged, ctx.runId);
    const notes = unacknowledged.filter((record) => record.kind === 'note');
    const reactions = await publisher.reactToNotes({ records: notes });
    await runDir.writeJson('rollup/feedback.digest.json', {
      ...built.digest, reactions, publication: digestPublication,
    });
    publication.digest = digestPublication;
    payload.digest.reactions = reactions;
    await runDir.writeJson('rollup/payload.json', payload);
    logger.info('publish.digest_posted', {
      ts: digestPublication.ts, acknowledged: marked, reactions: reactions.filter((r) => r.ok).length,
      reaction_failures: reactions.filter((r) => !r.ok).length,
    });
  }
  await runDir.writeJson('rollup/publication.json', publication);

  brief.publication = { channel_id: publication.channel_id, ts: publication.ts, permalink: publication.permalink };
  if (brief.image && publication.slack_file_id) {
    brief.image.slack_file_id = publication.slack_file_id;
  }
  await runDir.writeJson('rollup/brief.json', brief);
  logger.info('publish.done', { kind: brief.kind, ts: publication.ts, replies: publication.replies.length });
  return { posted: true, ts: publication.ts, permalink: publication.permalink };
};

module.exports = { name, inputs, run };
