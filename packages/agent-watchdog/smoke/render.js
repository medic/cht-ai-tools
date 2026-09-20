#!/usr/bin/env node
'use strict';
// Smoke test S-11 (research.md): render a report and its image with the real headless browser, writing only under
// TMPDIR, as the container does with a read-only root filesystem. No credentials needed; a browser must be installed
// (Playwright's chromium-headless-shell in the image, or AGENT_WATCHDOG_CHROMIUM_PATH).
// Usage: node smoke/render.js [--out <png path>]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderReport } = require('../src/render/report');
const { renderImage } = require('../src/render/browser');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RUN_ID = '2026-09-18';
const ALPHA = 'https://alpha.example.org';
const itemId = (n) => String(n).repeat(12);

const brief = {
  run_id: RUN_ID,
  kind: 'brief',
  headline: 'Sentinel backlog tripled on two Nepal projects; one alert stale',
  bullets: [
    {
      kind: 'alerts', item_id: null, group: 'MoH Nepal', alert_key: 'MoH Nepal',
      text: 'MoH Nepal alerts: 3 firing, 1 stale for more than 14 days',
      children: [{ item_id: null, text: 'backlog: 3 firing (Sentinel Backlog), oldest since 2026-08-20, 1 stale' }],
    },
    {
      kind: 'group', item_id: null, group: 'MoH Nepal', alert_key: null, text: 'MoH Nepal: 2 projects with issues',
      children: [
        { item_id: itemId(1), text: 'nepal-a.example.org cht_sentinel_backlog_count: 912 now vs 300 yesterday' },
        { item_id: itemId(2), text: 'nepal-b.example.org up{job="cht"}: 0 now vs 1 yesterday' },
      ],
    },
    { kind: 'item', item_id: itemId(3), group: 'Other', alert_key: null, children: [],
      text: 'alpha.example.org cht_conflict_count: 61 now vs 15 yesterday' },
  ],
  expected_load_notice: null,
  checked: { projects: 6, panels: 25, candidates: 7 },
  degradation_notice: null,
  notices: [],
  image: null,
  footer: { prompts_url: 'https://github.com/medic/cht-ai-tools', config_url: 'https://github.com/medic', trace_url: null, cost_usd: 0.42 },
  publication: null,
};
const item = (id, host, metric, value, before) => ({
  item_id: itemId(id), project_url: `https://${host}`, metric, severity: 'high', rank: id, placement: 'body', slot: id,
  evidence: [{ window: 'current', value, unit: 'count' }, { window: 'previous_day', value: before, unit: 'count' }],
  why_now: 'Climbed steadily for seven hours to three times yesterday.', suggested_check: 'Check the sentinel logs.',
  dashboard_ref: {
    dashboard_uid: 'oa2OfL-Vk', panel_id: 3, project_url: ALPHA,
    from: '2026-09-17T06:00:00Z', to: '2026-09-18T06:00:00Z',
  },
  confidence: 0.85, persisting_days: 1, pattern_card: null, candidate_ids: ['0123456789ab'],
  reference_urls: [], pass_history: [],
});
const items = [
  item(1, 'nepal-a.example.org', 'cht_sentinel_backlog_count', 912, 300),
  item(2, 'nepal-b.example.org', 'up{job="cht"}', 0, 1),
  item(3, 'alpha.example.org', 'cht_conflict_count', 61, 15),
];
const windowsByMetric = new Map(items.map((i) => [`${i.project_url}|${i.metric}`, [300, 320, 500, 700, 912]]));

const main = async () => {
  const outArg = process.argv.indexOf('--out');
  const outputPath = outArg !== -1
    ? process.argv[outArg + 1]
    : path.join(process.env.TMPDIR || os.tmpdir(), 'agent-watchdog-smoke', 'brief.png');
  const html = renderReport({ brief, items, windowsByMetric, runId: RUN_ID });
  if (!html.includes('id="brief-summary"') || /<script/.test(html)) {
    throw new Error('the report is missing its summary element or contains a script');
  }
  const subBullets = (html.match(/<ul class="sub">/g) || []).length;
  console.log(`ok   report rendered (${html.length} chars, sub-bullets: ${subBullets})`);
  const started = Date.now();
  const image = await renderImage({
    html, executablePath: process.env.AGENT_WATCHDOG_CHROMIUM_PATH || null, outputPath,
  });
  const bytes = fs.readFileSync(image.path);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.length < 1000) {
    throw new Error(`the image at ${image.path} is not a PNG of a plausible size (${bytes.length} bytes)`);
  }
  console.log(`ok   image rendered to ${image.path} (${bytes.length} bytes in ${Date.now() - started} ms)`);
  console.log(`ok   writable paths used: ${path.dirname(outputPath)} only (S-11)`);
};

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});
