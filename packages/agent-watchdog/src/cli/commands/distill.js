'use strict';
// `agent-watchdog distill [--all] [--item <path>...]` (FR-035, contracts/cli.md): turn new or changed corpus items
// into proposed pattern cards and print the distillation report. The only external call is the model; Grafana
// and Slack are never touched.
const fs = require('node:fs');
const codes = require('../exit-codes');
const { loadConfig } = require('../../config/load');
const { ensureDataLayout } = require('../../store/run-dir');
const { writeResult } = require('../streams');
const { createTracer } = require('../../trace/langfuse');
const { loadPatternCards } = require('../../corpus/cards');
const { distill } = require('../../corpus/distill');

const defaultCreateEngine = ({ config, env, logger }) => {
  const { loadDefinition } = require('../../agent/definition');
  const definition = loadDefinition({ paths: config.paths, env });
  const mcpConfig = { mcpServers: {} };
  if (config.model.engine === 'cli') {
    const { createCliEngine } = require('../../agent/engine-cli');
    return createCliEngine({ config, definition, mcpConfig, env, logger });
  }
  const { createSdkEngine } = require('../../agent/engine-sdk');
  return createSdkEngine({ config, definition, mcpConfig, env, logger });
};

module.exports = async function distillCommand({
  flags = {}, env = process.env, stdout = process.stdout, logger, deps = {},
}) {
  const { config } = loadConfig({ env, flags, command: 'distill' });
  const now = deps.now ? deps.now() : new Date();
  const date = now.toISOString().slice(0, 10);
  const runId = `distill-${date}`;
  const log = logger.child({ run_id: runId });
  const rawDir = config.storage.corpusRawDir;
  if (!fs.existsSync(rawDir)) {
    throw new codes.ExitError(
      codes.DATAERR, `corpus raw directory does not exist: ${rawDir} (AGENT_WATCHDOG_CORPUS_RAW_DIR)`,
    );
  }
  const dataDir = config.storage.dataDir;
  await ensureDataLayout(dataDir);
  const tracer = deps.tracer || createTracer({ config });
  await tracer.start({ runId, date, mode: 'manual', tags: ['distill'] });
  const startHr = process.hrtime.bigint();
  try {
    // Distillation is nothing without the model, so an engine that cannot be built fails the command loudly.
    const engine = deps.engine || (deps.createEngine || defaultCreateEngine)({ config, env, logger: log });
    const cards = deps.patternCards || loadPatternCards({ skillDir: config.paths.skillDir });
    const report = await tracer.stage('distill', () => distill({
      dataDir, rawDir, engine, config, cards, all: Boolean(flags.all), items: flags.item || [], now: () => now,
      logger: log,
    }));
    const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
    await tracer.finish({
      output: {
        status: 'completed', processed: report.processed.length, skipped: report.skipped.length,
        rejected: report.rejected.length, cards: report.cards.length, cost_usd: report.cost_usd,
      },
    });
    log.info('distill.done', {
      processed: report.processed.length, skipped: report.skipped.length, rejected: report.rejected.length,
      cards: report.cards.map((c) => c.card_id), cost_usd: report.cost_usd, duration_ms: durationMs,
    });
    writeResult(stdout, report);
    return codes.OK;
  } catch (error) {
    log.error('distill.failed', { error });
    try {
      await tracer.finish({ output: { status: 'failed', error: error.message } });
    } catch (traceError) {
      log.warn('trace.finish_failed', { error: traceError });
    }
    throw error;
  }
};
