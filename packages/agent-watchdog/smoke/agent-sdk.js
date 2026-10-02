#!/usr/bin/env node
'use strict';
// Smoke tests S-1, S-2, S-4, S-5 (research.md): the real Agent SDK with the findings schema.
// S-1 structured output on every turn of a streaming-input session; S-2 the Stop hook fires per turn;
// S-4 the structured-output implementation accepts the committed schemas; S-5 hooks under CLAUDE_CODE_SIMPLE.
// Needs ANTHROPIC_API_KEY. Costs a few cents. Usage: node --env-file=.env smoke/agent-sdk.js [--simple]
const { loadConfig } = require('../src/config/load');
const { createLogger } = require('../src/log/logger');
const { loadDefinition } = require('../src/agent/definition');
const { createSdkEngine } = require('../src/agent/engine-sdk');
const { toJsonSchemas } = require('../src/agent/output-schema');

const main = async () => {
  const { config } = loadConfig({ command: 'run', flags: { 'dry-run': true } });
  const logger = createLogger({ level: 'info', format: 'pretty' });
  const definition = loadDefinition({ paths: config.paths, env: process.env, config });
  const env = { ...process.env };
  if (process.argv.includes('--simple')) {
    env.CLAUDE_CODE_SIMPLE = '1';
  }
  let stopHookCalls = 0;
  const engine = createSdkEngine({
    config,
    definition,
    mcpConfig: { mcpServers: {} },
    env,
    logger,
    onStopHook: () => {
      stopHookCalls += 1;
    },
  });
  const schemas = toJsonSchemas();
  const session = await engine.openSession({
    systemPrompt: [
      'You are a test harness. Answer only with the requested JSON.',
      '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
      '',
    ],
    outputSchema: schemas.findings,
    tools: [],
    mcpConfig: { mcpServers: {} },
    bounds: { maxTurns: 2, maxBudgetUsd: 0.5, timeoutMs: 120000 },
    model: config.model.name,
    effort: 'low',
    sessionName: 'smoke',
  });
  const prompt = (pass) => `Return a findings document for project_url https://smoke.example.org, pass ${pass}, `
    + 'with zero items, an empty not_selected list, empty changes, converged true and notes "smoke".';
  const results = [];
  for (const pass of [1, 2]) {
    const turn = await session.turn(prompt(pass));
    results.push(turn);
    const ok = turn.structuredOutput && turn.structuredOutput.pass === pass;
    const status = ok ? 'ok  ' : 'FAIL';
    console.log(`${status} turn ${pass}: subtype=${turn.result.subtype}`
      + ` structured_output=${Boolean(turn.structuredOutput)} cost=$${turn.result.total_cost_usd}`);
  }
  await session.close();
  console.log(`${stopHookCalls >= 1 ? 'ok  ' : 'WARN'} Stop hook fired ${stopHookCalls} time(s) (S-2, S-5)`);
  const allSuccess = results.every((r) => r.result.subtype === 'success');
  console.log(`${allSuccess ? 'ok  ' : 'FAIL'} schema accepted by the runtime (S-4)`);
  process.exitCode = results.every((r) => r.structuredOutput) ? 0 : 1;
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
