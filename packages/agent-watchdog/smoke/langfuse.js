#!/usr/bin/env node
'use strict';
// Smoke test S-9 (research.md R-8): with real Langfuse credentials, one trace with a stage span and a generation is
// written, getTraceUrl returns a link that opens the trace, and forceFlush completes before the process exits.
// Needs LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (plus the other values `run` validates).
// Usage: node --env-file=.env smoke/langfuse.js
const { loadConfig } = require('../src/config/load');
const { createTracer } = require('../src/trace/langfuse');

const FLUSH_TIMEOUT_MS = 20000;

const main = async () => {
  const { config } = loadConfig({ command: 'run', flags: { 'dry-run': true }, withPolicy: false });
  const tracer = createTracer({ config });
  const runId = `smoke-${Date.now()}`;
  const { traceId } = await tracer.start({ runId, date: new Date().toISOString().slice(0, 10), mode: 'smoke' });
  console.log(`ok   trace started (${traceId})`);
  await tracer.stage('smoke-stage', async () => {
    tracer.generation({
      name: 'smoke generation', model: config.model.name, input: 'smoke', output: 'smoke',
      usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0, durationMs: 1,
    });
  });
  const url = await tracer.traceUrl();
  const fromClient = url && !url.endsWith(`/trace/${traceId}`);
  const origin = fromClient ? 'from getTraceUrl' : 'fallback form';
  console.log(`${url ? 'ok  ' : 'FAIL'} trace url ${url || 'missing'} (${origin})`);
  const started = Date.now();
  await Promise.race([
    tracer.finish({ output: { status: 'smoke' } }),
    new Promise((resolve, reject) => {
      const message = `forceFlush did not complete within ${FLUSH_TIMEOUT_MS} ms`;
      setTimeout(() => reject(new Error(message)), FLUSH_TIMEOUT_MS);
    }),
  ]);
  console.log(`ok   flushed and shut down in ${Date.now() - started} ms`);
  console.log('     open the trace url to confirm the stage span and the generation are attached');
  process.exitCode = url ? 0 : 1;
};

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});
