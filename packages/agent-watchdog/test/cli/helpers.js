'use strict';
// Scaffolding shared by the run-command specs: captured streams, a complete environment, a fake tracer,
// scripted stages and a stubbed Slack client. Nothing here touches the network.
const path = require('node:path');
const { Writable } = require('node:stream');
const { createLogger } = require('../../src/log/logger');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const DATE = '2026-09-18';

const capture = () => {
  const chunks = [];
  const stream = new Writable({
    write(c, e, cb) {
      chunks.push(c.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
};

const envFor = (dataDir, extra = {}) => ({
  ANTHROPIC_API_KEY: 'sk-ant-test',
  SLACK_BOT_TOKEN: 'xoxb-test',
  AGENT_WATCHDOG_GRAFANA_TOKEN: 'glsa_test',
  LANGFUSE_PUBLIC_KEY: 'pk',
  LANGFUSE_SECRET_KEY: 'sk',
  AGENT_WATCHDOG_GRAFANA_URL: 'https://watchdog.example.org',
  AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID: 'PBFA97CFB590B2093',
  AGENT_WATCHDOG_SLACK_CHANNEL_ID: 'C123',
  AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp',
  LANGFUSE_BASE_URL: 'https://langfuse.example.org',
  AGENT_WATCHDOG_SPECS_URL: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/specs/001-watchdog-slack-loop',
  AGENT_WATCHDOG_CONFIG_URL: 'https://github.com/medic/medic-infrastructure',
  AGENT_WATCHDOG_DATA_DIR: dataDir,
  AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR,
  ...extra,
});

const fakeTracer = () => ({
  start: sinon.stub().resolves({ traceId: 't1' }),
  stage: sinon.spy(async (name, fn) => fn()),
  generation: sinon.stub(),
  traceUrl: sinon.stub().resolves('https://langfuse.example.org/trace/t1'),
  finish: sinon.stub().resolves(),
  traceId: 't1',
});

const STAGE_RESULTS = {
  purge: { removed: 0 },
  feedback: { records: 0 },
  collect: { projects: 2, metrics: 10 },
  analyze: { projects: 2, candidates: 3 },
  agent: { projects_analysed: 1, projects_skipped: 1, items: 2, cost_usd: 0.5, bounds_hit: [], usage: null },
  rollup: { kind: 'brief', items: 2, bullets: 2, degraded: false },
  render: { rendered: true },
  publish: { posted: true, ts: '1.1', permalink: 'https://slack.example/p1' },
};

/**
 * Scripted stages: each records that it ran and returns its result; a function result runs with the ctx and
 * may write artefacts; an Error result is thrown.
 */
const fakeStages = (overrides = {}) => {
  const calls = [];
  const make = (name, result) => ({
    name,
    inputs: [],
    run: sinon.spy(async (ctx) => {
      calls.push(name);
      if (result instanceof Error) {
        throw result;
      }
      if (typeof result === 'function') {
        return result(ctx);
      }
      if (name === 'rollup') {
        await ctx.runDir.writeJson('rollup/brief.json', { kind: result.kind || 'brief' });
      }
      return result;
    }),
  });
  const merged = { ...STAGE_RESULTS, ...overrides };
  const stages = Object.fromEntries(Object.entries(merged).map(([n, r]) => [n, make(n, r)]));
  return { stages, calls };
};

const fakeSlackClient = () => ({
  files: { uploadV2: sinon.stub().resolves({ ok: true, files: [{ files: [{ id: 'F1' }] }] }) },
  chat: {
    postMessage: sinon.stub().callsFake(async ({ thread_ts: threadTs }) => ({
      ok: true, channel: 'C123', ts: threadTs ? `${threadTs}9` : '1.000',
    })),
    getPermalink: sinon.stub().callsFake(async ({ message_ts: ts }) => ({ ok: true, permalink: `https://slack/p${ts}` })),
  },
});

/** Arguments for the run command with every external dependency faked; override flags, env and deps. */
const runArgs = (dataDir, extra = {}) => {
  const out = capture();
  const err = capture();
  const slackPublisher = { postFailureNotice: sinon.stub().resolves({ ts: '9.9' }) };
  return {
    out,
    err,
    slackPublisher,
    args: {
      command: 'run',
      flags: { date: DATE, ...(extra.flags || {}) },
      positionals: [],
      env: { ...envFor(dataDir), ...(extra.env || {}) },
      stdout: out.stream,
      stderr: err.stream,
      logger: createLogger({ stream: err.stream, level: 'warn' }),
      deps: {
        tracer: fakeTracer(),
        slackPublisher,
        gate: {},
        engine: {},
        gitSha: 'abc1234',
        ...(extra.deps || {}),
      },
    },
  };
};

/** Run the command and return { code, error } instead of throwing. */
const attempt = async (command, args) => {
  try {
    return { code: await command(args), error: null };
  } catch (error) {
    return { code: null, error };
  }
};

module.exports = {
  DATE, DEFAULTS_DIR, capture, envFor, fakeTracer, fakeStages, fakeSlackClient, runArgs, attempt, STAGE_RESULTS,
};
