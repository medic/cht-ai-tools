'use strict';
// Apply retention at the start of every run (FR-040). Also exposed as the `purge` command.
const { purge } = require('../../store/retention');

module.exports = {
  name: 'purge',
  inputs: [],
  async run(ctx) {
    const now = ctx.deps && ctx.deps.now ? ctx.deps.now() : new Date();
    const result = await purge(ctx.config.storage.dataDir, {
      rawDays: ctx.config.storage.retentionRawDays,
      keptDays: ctx.config.storage.retentionDays,
      now,
      dryRun: Boolean(ctx.purgeDryRun),
    });
    for (const removed of result.removed) {
      ctx.logger.info('purge.removed', removed);
    }
    ctx.logger.info('purge.done', { removed: result.removed.length, compacted: result.compacted });
    return { removed: result.removed.length, compacted: result.compacted };
  },
};
