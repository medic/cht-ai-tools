'use strict';
// Stage: feedback. Reads reactions and notes from the previous runs' posts at the start of each run
// (FR-026 to FR-030) and writes feedback.ingested.json for the analysis, roll-up and corpus stages.
const { ingestFeedback } = require('../../feedback/ingest');

const name = 'feedback';
const inputs = [];

const emptyDocument = (runId, skipped) => ({
  run_id: runId, since: null, sources: [], records: [], unmatched: [], horizons: [], by_item: {},
  brief: { up: 0, down: 0, notes: [] }, projects: {}, skipped,
});

const slackClient = (ctx) => {
  if (ctx.deps && ctx.deps.slack) {
    return ctx.deps.slack;
  }
  const { WebClient } = require('@slack/web-api');
  return new WebClient(ctx.config.secrets.slackBotToken);
};

const run = async (ctx) => {
  const { runDir, logger, config } = ctx;
  const injected = ctx.deps && ctx.deps.slack;
  if (!injected && !config.secrets.slackBotToken) {
    const reason = 'no Slack credentials';
    await runDir.writeJson('feedback.ingested.json', emptyDocument(ctx.runId, reason));
    logger.info('feedback.skipped', { reason });
    return { records: 0, unmatched: 0, horizons: 0, sources: 0, skipped: reason };
  }
  const document = await ingestFeedback({
    client: slackClient(ctx),
    channel: config.endpoints.slackChannelId,
    dataDir: config.storage.dataDir,
    runId: ctx.runId,
    date: ctx.date,
    lookbackRuns: config.behaviour.feedbackLookbackRuns,
    since: (ctx.flags && ctx.flags.since) || null,
    engine: ctx.engine || null,
    model: config.model.feedback,
    definition: ctx.definition || null,
    logger,
    now: ctx.deps && ctx.deps.now ? ctx.deps.now : undefined,
  });
  await runDir.writeJson('feedback.ingested.json', document);
  logger.info('feedback.done', {
    records: document.records.length, unmatched: document.unmatched.length, horizons: document.horizons.length,
  });
  return {
    records: document.records.length,
    unmatched: document.unmatched.length,
    horizons: document.horizons.length,
    sources: document.sources.length,
  };
};

module.exports = { name, inputs, run };
