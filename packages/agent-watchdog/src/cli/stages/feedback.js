'use strict';
// Feedback ingestion arrives with User Story 2 (FR-026 to FR-030). Until then this stage writes an
// empty, explicit record so later stages have a stable input and nothing is skipped silently.
module.exports = {
  name: 'feedback',
  inputs: [],
  async run(ctx) {
    const record = {
      run_id: ctx.runId,
      records: [],
      unmatched: [],
      horizons: [],
      note: 'feedback ingestion is delivered by User Story 2; this run read no feedback',
    };
    await ctx.runDir.writeJson('feedback.ingested.json', record);
    ctx.logger.info('feedback.passthrough', { records: 0 });
    return { records: 0, unmatched: 0 };
  },
};
