'use strict';
// Stage: feedback. Reads reactions and notes from the previous runs' posts at the start of each run
// (FR-026 to FR-030), reviews the day's notes so their lessons become proposals (FR-061), and writes
// feedback.ingested.json for the analysis, roll-up, publish and corpus stages.
const fs = require('node:fs');
const { ingestFeedback } = require('../../feedback/ingest');
const { reviewFeedback, promptFile } = require('../../feedback/review');
const { readUnacknowledged } = require('../../feedback/store');
const { buildAllowlist, allowedHosts } = require('../../links/allowlist');

const name = 'feedback';
const inputs = [];

const NO_REVIEW = Object.freeze({ skipped: 'no engine', classified: [], unclassified: [], calls: [] });

const emptyDocument = (runId, skipped) => ({
  run_id: runId, since: null, sources: [], records: [], unmatched: [], horizons: [], by_item: {}, alerts: {},
  brief: { up: 0, down: 0, notes: [] }, projects: {}, skipped, review: { ...NO_REVIEW, skipped },
});

const slackClient = (ctx) => {
  if (ctx.deps && ctx.deps.slack) {
    return ctx.deps.slack;
  }
  const { WebClient } = require('@slack/web-api');
  return new WebClient(ctx.config.secrets.slackBotToken);
};

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** Hosts to mask in proposals: discovery when the run has it, else the hosts named by the feedback itself. */
const hostsFor = async (ctx, document) => {
  if (ctx.runDir.exists('discovery.json')) {
    const discovery = await ctx.runDir.readJson('discovery.json');
    return (discovery.projects || []).map((p) => p.host);
  }
  return [...new Set(Object.values(document.by_item).map((entry) => hostOf(entry.project_url)).filter(Boolean))];
};

const review = async (ctx, document) => {
  const { config } = ctx;
  if (!ctx.engine) {
    return { ...NO_REVIEW };
  }
  const dataDir = config.storage.dataDir;
  const unacknowledged = await readUnacknowledged(dataDir);
  const notes = unacknowledged.filter((record) => record.kind === 'note' && record.classification === null);
  return reviewFeedback({
    dataDir,
    runDir: ctx.runDir,
    runId: ctx.runId,
    date: ctx.date,
    records: [...notes, ...unacknowledged.filter((record) => record.kind === 'reaction')],
    byItem: document.by_item,
    engine: ctx.engine,
    config,
    promptText: fs.readFileSync(promptFile(config.paths.promptsDir), 'utf8'),
    hosts: await hostsFor(ctx, document),
    persons: [...new Set(unacknowledged.map((record) => record.author).filter(Boolean))],
    allowedHosts: allowedHosts(buildAllowlist(config)),
    logger: ctx.logger,
    now: ctx.deps && ctx.deps.now ? ctx.deps.now : undefined,
  });
};

const run = async (ctx) => {
  const { runDir, logger, config } = ctx;
  const injected = ctx.deps && ctx.deps.slack;
  if (!injected && !config.secrets.slackBotToken) {
    const reason = 'no Slack credentials';
    await runDir.writeJson('feedback.ingested.json', emptyDocument(ctx.runId, reason));
    logger.info('feedback.skipped', { reason });
    return { records: 0, unmatched: 0, horizons: 0, sources: 0, reviewed: 0, skipped: reason };
  }
  const document = await ingestFeedback({
    client: slackClient(ctx),
    channel: config.endpoints.slackChannelId,
    dataDir: config.storage.dataDir,
    runId: ctx.runId,
    date: ctx.date,
    lookbackRuns: config.behaviour.feedbackLookbackRuns,
    influenceDays: config.behaviour.feedbackInfluenceDays,
    since: (ctx.flags && ctx.flags.since) || null,
    engine: ctx.engine || null,
    model: config.model.feedback,
    definition: ctx.definition || null,
    logger,
    now: ctx.deps && ctx.deps.now ? ctx.deps.now : undefined,
  });
  document.review = await review(ctx, document);
  await runDir.writeJson('feedback.ingested.json', document);
  logger.info('feedback.done', {
    records: document.records.length, unmatched: document.unmatched.length, horizons: document.horizons.length,
    reviewed: document.review.classified.length, unclassified: document.review.unclassified.length,
    review_skipped: document.review.skipped || null,
  });
  return {
    records: document.records.length,
    unmatched: document.unmatched.length,
    horizons: document.horizons.length,
    sources: document.sources.length,
    reviewed: document.review.classified.length,
    unclassified: document.review.unclassified.length,
  };
};

module.exports = { name, inputs, run };
