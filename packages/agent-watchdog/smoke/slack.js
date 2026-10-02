#!/usr/bin/env node
'use strict';
// Smoke test S-8 (research.md): a private file upload through files.uploadV2, registered metadata, and read-back
// through conversations.replies with include_all_metadata. Posts to the configured channel only when --yes is given;
// otherwise it stops after the upload. A run uploads no image since revision 24; the report share into the thread is
// smoke test S-31 and is exercised by a hosted dry run turned live, not here.
// Usage: node --env-file=.env smoke/slack.js [--yes] [--react <message ts>]
// S-16 (research.md R-14): the posted brief carries a group bullet whose sub-bullets are indented `◦` lines inside
// the section; check that they render legibly on Slack desktop and mobile.
// S-13 (research.md R-13): with --react <ts>, add the `eyes` reaction to that message twice; the second call must
// report already_reacted, and a token without reactions:write must report missing_scope. Nothing else runs.
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
    bullets: [
      { item_id: 'a1b2c3d4e5f6', text: 'Smoke item: sentinel backlog 912 vs 300 yesterday' },
      {
        kind: 'group', item_id: null, group: 'Smoke programme', text: 'Smoke programme: 2 projects with issues',
        alert_key: null,
        children: [
          { item_id: 'b2c3d4e5f6a1', text: 'smoke-a.example.org sentinel backlog 400 vs 100 yesterday' },
          { item_id: 'c3d4e5f6a1b2', text: 'smoke-b.example.org outbound push backlog 3 vs 0 yesterday' },
        ],
      },
    ],
    expected_load_notice: null,
    checked: { projects: 1, panels: 1, candidates: 1 },
    degradation_notice: null,
    image: null,
    footer: {
      specs_url: config.endpoints.specsUrl,
      config_url: config.endpoints.configUrl,
      trace_url: null,
      cost_usd: 0,
    },
    publication: null,
  };
  const smokeItem = (itemId, host, metric, rank) => ({
    item_id: itemId,
    project_url: `https://${host}`,
    metric,
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
    rank,
    placement: 'body',
    slot: rank === 1 ? 1 : 2,
    pass_history: [],
  });
  const items = [
    smokeItem('a1b2c3d4e5f6', 'smoke.example.org', 'cht_sentinel_backlog_count', 1),
    smokeItem('b2c3d4e5f6a1', 'smoke-a.example.org', 'cht_sentinel_backlog_count', 2),
    smokeItem('c3d4e5f6a1b2', 'smoke-b.example.org', 'cht_outbound_push_backlog_count', 3),
  ];
  const payload = buildPayload({ brief, items, links: new Map(), runId, date: runId, audience: 'internal' });
  const publisher = createSlackPublisher({ client, channel, logger });
  const publication = await publisher.publish({ payload });
  console.log(`ok   posted ${publication.permalink} with ${publication.replies.length} replies`);
  console.log('S-16: open the post and confirm the two indented sub-bullets under "Smoke programme" read well');

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
