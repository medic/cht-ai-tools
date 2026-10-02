'use strict';
// `agent-watchdog purge [--dry-run]` (FR-040, contracts/cli.md): apply retention to the data volume and print what was
// removed, or with --dry-run what would be. The same code runs as the first stage of every `run`
// (src/cli/stages/purge.js). Needs no Grafana, Slack, model or tracing configuration.
const codes = require('../exit-codes');
const { loadConfig } = require('../../config/load');
const { purge } = require('../../store/retention');
const { writeResult } = require('../streams');

module.exports = async function purgeCommand({
  flags = {}, env = process.env, stdout = process.stdout, logger, deps = {},
}) {
  const { config } = loadConfig({ env, flags, command: 'purge', withPolicy: false });
  const dryRun = Boolean(flags['dry-run']);
  const now = deps.now ? deps.now() : new Date();
  const retention = { raw_days: config.storage.retentionRawDays, kept_days: config.storage.retentionDays };
  const result = await purge(config.storage.dataDir, {
    rawDays: retention.raw_days, keptDays: retention.kept_days, now, dryRun,
  });
  if (logger) {
    for (const removed of result.removed) {
      logger.info(dryRun ? 'purge.would_remove' : 'purge.removed', removed);
    }
    logger.info('purge.done', { dry_run: dryRun, removed: result.removed.length, ...retention });
  }
  writeResult(stdout, {
    data_dir: config.storage.dataDir, dry_run: dryRun, retention, removed: result.removed, compacted: result.compacted,
  });
  return codes.OK;
};
