#!/usr/bin/env node
'use strict';
// A stand-in for the `claude` executable for the CLI-engine tests and the User Story 3 end-to-end test. It speaks
// the print-mode stream-json protocol: one init event, then, for every user message on stdin, the scripted
// events and a result. Driven by environment variables:
//   FAKE_CLAUDE_RECORD    JSONL file receiving { event: 'start', argv, env } and { event: 'stdin', line } events
//   FAKE_CLAUDE_MODE      scripted (default) | findings | hang | chatter
//   FAKE_CLAUDE_SCENARIO  scripted mode: JSON { session_id?, mcp_servers?, turns: [{ messages, result }] }
//   FAKE_CLAUDE_DATA_DIR  findings mode: the data volume whose latest run answers the prompt
//   FAKE_CLAUDE_CHATTER   chatter mode: assistant messages emitted per user message, never a result
// Like the real CLI 2.1.278 it refuses print-mode stream-json output without --verbose.
const fs = require('node:fs');
const readline = require('node:readline');

const argv = process.argv.slice(2);
const env = process.env;

if (!argv.includes('--verbose')) {
  process.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\n');
  process.exitCode = 1;
  return;
}

const recordFile = env.FAKE_CLAUDE_RECORD || null;
const record = (event) => {
  if (recordFile) {
    fs.appendFileSync(recordFile, `${JSON.stringify(event)}\n`);
  }
};
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const mode = env.FAKE_CLAUDE_MODE || 'scripted';
const scenario = mode === 'scripted' ? JSON.parse(fs.readFileSync(env.FAKE_CLAUDE_SCENARIO, 'utf8')) : {};
const sessionId = scenario.session_id || 'fake-cli-session';

// The start record also carries what the engine put in the environment, so tests can check each authentication
// mode: the config-directory override, whether an API key reached the process, and the auto-memory switch.
record({
  event: 'start', argv, pid: process.pid,
  env: {
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR || null,
    has_api_key: Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY'),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || null,
  },
});
emit({
  type: 'system', subtype: 'init', session_id: sessionId,
  mcp_servers: scenario.mcp_servers || [{ name: 'cht-docs', status: 'connected' }],
});

const contentText = (message) => {
  const content = message.message && message.message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block === 'string' ? block : block.text || '')).join('');
  }
  return '';
};

let turnIndex = 0;
let lastProject = null;

const answerScripted = () => {
  const turns = scenario.turns || [];
  const turn = turns[Math.min(turnIndex - 1, turns.length - 1)] || { messages: [], result: {} };
  for (const message of turn.messages || []) {
    emit(message);
  }
  emit({ type: 'result', session_id: sessionId, ...turn.result });
};

const answerFindings = async (message) => {
  const scripted = require('./scripted-findings');
  const root = scripted.latestRunRoot(env.FAKE_CLAUDE_DATA_DIR);
  const project = scripted.projectForPrompt(root, contentText(message)) || lastProject;
  lastProject = project;
  const findings = await scripted.findingsFor(project, turnIndex);
  const stub = scripted.resultStub();
  emit({
    type: 'result', ...stub, session_id: sessionId,
    total_cost_usd: Number((stub.total_cost_usd * turnIndex).toFixed(6)), structured_output: findings,
  });
};

const answerChatter = () => {
  const count = Number(env.FAKE_CLAUDE_CHATTER || 3);
  for (let i = 1; i <= count; i += 1) {
    emit({
      type: 'assistant', session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: `thinking ${i}` }] },
    });
  }
};

const answer = async (message) => {
  turnIndex += 1;
  if (mode === 'hang') {
    return;
  }
  if (mode === 'chatter') {
    answerChatter();
    return;
  }
  if (mode === 'findings') {
    await answerFindings(message);
    return;
  }
  answerScripted();
};

const main = async () => {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    record({ event: 'stdin', line: message });
    if (message.type === 'user') {
      await answer(message);
    }
  }
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
