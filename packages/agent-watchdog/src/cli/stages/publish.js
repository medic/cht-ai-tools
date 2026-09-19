'use strict';
// Stage: publish. Builds the exact payload, writes it, and posts it unless the run is a preview (FR-019, FR-025).
const { requireInputs } = require('./index');
const { buildPayload } = require('../../publish/payload');
const { createSlackPublisher } = require('../../publish/slack');

const name = 'publish';
const inputs = ['rollup/brief.json'];

const slackClient = (ctx) => {
  if (ctx.deps && ctx.deps.slack) {
    return ctx.deps.slack;
  }
  const { WebClient } = require('@slack/web-api');
  return new WebClient(ctx.config.secrets.slackBotToken);
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

  const payload = buildPayload({
    brief,
    items,
    links,
    runId: ctx.runId,
    date: ctx.date,
    audience: 'internal',
    channel,
    unmatchedNotes: ctx.feedbackUnmatched || [],
  });
  await runDir.writeJson('rollup/payload.json', payload);

  if (ctx.mode === 'preview') {
    logger.info('publish.preview', { kind: brief.kind, replies: payload.replies.length });
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
