#!/usr/bin/env node
'use strict';
// Smoke test S-8 (research.md): private image upload referenced by slack_file.id, registered metadata,
// and read-back through conversations.replies with include_all_metadata. Posts to the configured channel
// only when --yes is given; otherwise it stops after the upload.
// Usage: node --env-file=.env smoke/slack.js [--yes] [--react <message ts>]
// S-13 (research.md R-13): with --react <ts>, add the `eyes` reaction to that message twice; the second call must
// report already_reacted, and a token without reactions:write must report missing_scope. Nothing else runs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebClient } = require('@slack/web-api');
const { loadConfig } = require('../src/config/load');
const { createLogger } = require('../src/log/logger');
const { createSlackPublisher } = require('../src/publish/slack');
const { buildPayload } = require('../src/publish/payload');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const main = async () => {
  const { config } = loadConfig({ command: 'run' });
  const logger = createLogger({ level: 'info', format: 'pretty' });
  const client = new WebClient(config.secrets.slackBotToken);
  const channel = config.endpoints.slackChannelId;
  const reactAt = process.argv.indexOf('--react');
  if (reactAt !== -1) {
    const timestamp = process.argv[reactAt + 1];
    if (!timestamp) {
      console.error('FAIL --react needs the ts of a message in the configured channel');
      process.exitCode = 1;
      return;
    }
    const react = async (label) => {
      try {
        await client.reactions.add({ channel, timestamp, name: 'eyes' });
        console.log(`ok   ${label}: eyes reaction added to ${timestamp}`);
        return 'added';
      } catch (error) {
        const code = error && error.data && error.data.error;
        if (code === 'already_reacted') {
          console.log(`ok   ${label}: already_reacted reported, treated as success`);
          return 'already_reacted';
        }
        if (code === 'missing_scope') {
          console.log(`FAIL ${label}: the bot token lacks the reactions:write scope (S-13 prerequisite)`);
          process.exitCode = 1;
          return 'missing_scope';
        }
        console.log(`FAIL ${label}: ${error.message}`);
        process.exitCode = 1;
        return 'error';
      }
    };
    const first = await react('first reactions.add');
    if (first === 'added' || first === 'already_reacted') {
      const second = await react('second reactions.add');
      if (second !== 'already_reacted') {
        console.log('WARN the second call did not report already_reacted; check the reaction is on the message');
      }
    }
    return;
  }
  const runId = `smoke-${Date.now()}`;
  const imagePath = path.join(os.tmpdir(), `${runId}.png`);
  fs.writeFileSync(imagePath, PNG_1X1);

  const upload = await client.files.uploadV2({
    file: PNG_1X1,
    filename: `${runId}.png`,
    title: 'agent-watchdog smoke',
  });
  const fileId = upload.files[0].files[0].id;
  console.log(`ok   uploaded private file ${fileId}`);

  if (!process.argv.includes('--yes')) {
    console.log('stopping before posting; pass --yes to post a smoke message to the configured channel');
    return;
  }

  const brief = {
    run_id: runId,
    kind: 'brief',
    headline: 'agent-watchdog smoke test',
    bullets: [{ item_id: 'a1b2c3d4e5f6', text: 'Smoke item: sentinel backlog 912 vs 300 yesterday' }],
    expected_load_notice: null,
    checked: { projects: 1, panels: 1, candidates: 1 },
    degradation_notice: null,
    image: { path: imagePath, slack_file_id: fileId },
    footer: {
      prompts_url: config.endpoints.promptsUrl,
      config_url: config.endpoints.configUrl,
      trace_url: null,
      cost_usd: 0,
    },
    publication: null,
  };
  const items = [{
    item_id: 'a1b2c3d4e5f6',
    project_url: 'https://smoke.example.org',
    metric: 'cht_sentinel_backlog_count',
    severity: 'low',
    evidence: [],
    why_now: 'smoke',
    suggested_check: 'nothing',
    dashboard_ref: null,
    confidence: 0.5,
    persisting_days: 1,
    pattern_card: null,
    candidate_ids: ['x'],
    reference_urls: [],
    rank: 1,
    placement: 'body',
    pass_history: [],
  }];
  const payload = buildPayload({ brief, items, links: new Map(), runId, date: runId, audience: 'internal' });
  const publisher = createSlackPublisher({ client, channel, logger });
  const publication = await publisher.publish({ payload, imagePath });
  console.log(`ok   posted ${publication.permalink} with ${publication.replies.length} replies`);

  const replies = await client.conversations.replies({ channel, ts: publication.ts, include_all_metadata: true });
  const withMetadata = replies.messages.filter((m) => m.metadata && m.metadata.event_type);
  console.log(`ok   read back ${replies.messages.length} messages, ${withMetadata.length} with registered metadata`);
  if (withMetadata.length === 0) {
    console.log('WARN metadata was not returned: register agent_watchdog.brief and agent_watchdog.item '
      + 'in the app manifest');
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
