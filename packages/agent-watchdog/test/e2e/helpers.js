// Shared end-to-end helpers: a fake Slack client, a fake browser, a scripted model that answers from the run
// directory, and runCase, which drives the real run command against the fake Grafana. Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const runCommand = require('../../src/cli/commands/run');
const { createLogger } = require('../../src/log/logger');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath } = require('../helpers/fixtures');
const scripted = require('../helpers/scripted-findings');

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
  PATH: process.env.PATH,
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
  AGENT_WATCHDOG_PROMPTS_URL: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/prompts',
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

const fakeSlack = () => {
  let counter = 0;
  return {
    files: { uploadV2: sinon.stub().resolves({ ok: true, files: [{ files: [{ id: 'F0001' }] }] }) },
    reactions: { add: sinon.stub().resolves({ ok: true }) },
    chat: {
      postMessage: sinon.spy(async () => {
        counter += 1;
        return { ok: true, channel: 'C123', ts: `1700000000.00${String(counter).padStart(4, '0')}` };
      }),
      getPermalink: sinon.spy(async ({ message_ts: ts }) => ({ ok: true, permalink: `https://medic.slack.com/archives/C123/p${ts}` })),
    },
  };
};

const fakeBrowserLauncher = () => {
  const page = {
    route: sinon.stub().resolves(),
    setContent: sinon.stub().resolves(),
    locator: sinon.stub().returns({ screenshot: sinon.stub().resolves(Buffer.from('fake-png')) }),
  };
  const context = { newPage: sinon.stub().resolves(page), close: sinon.stub().resolves() };
  const browser = { newContext: sinon.stub().resolves(context), close: sinon.stub().resolves() };
  return { launch: sinon.stub().resolves(browser), page, context, browser };
};

// Reads the run directory to answer like a careful model would: one item per metric with evidence
// equal to the computed values (test/helpers/scripted-findings.js), and a brief whose numbers come from the
// same evidence.
// proposals: brief-draft proposals to emit; memoryText: a memory update to emit instead of the feedback notes;
// condense: { maxChars, mode: 'fit' | 'overflow' } answers the memory-condensation call.
const createScriptedEngine = ({
  dataDir, briefMode = 'good', useTools = false, proposals = [], memoryText = undefined, condense = null,
}) => {
  const { formatValue } = require('../../src/verify/format');
  const calls = { sessions: [], turns: [], singleTurns: [] };

  const result = scripted.resultStub;

  const openSession = async (options) => {
    calls.sessions.push(options);
    let pass = 0;
    let sessionProject = null;
    return {
      async turn(userText) {
        pass += 1;
        calls.turns.push({ pass, userText });
        // A revision turn may carry only reasons; the session stays bound to the project of its first turn.
        const matched = scripted.projectForPrompt(scripted.latestRunRoot(dataDir), userText);
        sessionProject = matched || sessionProject;
        const findings = await scripted.findingsFor(sessionProject, pass);
        // With useTools the session really calls get_windows through the engine's local tools, so the session
        // loop records the call and a replay can answer it from the recording.
        const toolCalls = [];
        const getWindows = useTools ? (options.localTools || []).find((t) => t.name === 'get_windows') : null;
        if (getWindows && sessionProject.candidates.length) {
          const toolInput = { metric: sessionProject.candidates[0].metric };
          const out = await getWindows.handler(toolInput);
          toolCalls.push({
            tool_name: 'mcp__watchdog__get_windows', tool_input: toolInput, tool_response: out.content[0].text,
          });
        }
        return { structuredOutput: findings, result: result(), toolCalls, referenceUnavailable: false };
      },
      async close() {},
    };
  };

  // Existing memory plus one line per feedback note visible in this run's ingested feedback, or null.
  const memoryFromFeedback = () => {
    const runsDir = path.join(dataDir, 'runs');
    const runId = fs.readdirSync(runsDir).sort().pop();
    const ingestedPath = path.join(runsDir, runId, 'feedback.ingested.json');
    if (!fs.existsSync(ingestedPath)) {
      return null;
    }
    const ingested = JSON.parse(fs.readFileSync(ingestedPath, 'utf8'));
    const notes = [];
    for (const entry of Object.values(ingested.by_item || {})) {
      notes.push(...(entry.notes || []));
    }
    for (const record of ingested.unmatched || []) {
      notes.push(record.note);
    }
    if (!notes.length) {
      return null;
    }
    const memoryPath = path.join(dataDir, 'memory', 'memory.md');
    const existing = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '';
    return `${existing}${existing ? '\n' : ''}${notes.map((n) => `- note (${runId}): ${n}`).join('\n')}\n`;
  };

  // The memory condenser asks for a shorter memory; answer with the newest lines that fit, or overflow on purpose.
  const condensed = (userPrompt) => {
    const match = /<untrusted source="memory">\n([\s\S]*?)\n<\/untrusted>/.exec(userPrompt);
    const memory = match ? match[1] : '';
    if (condense && condense.mode === 'overflow') {
      return `${memory}\n${'overflow '.repeat(200)}\n`;
    }
    const limit = condense && condense.maxChars ? condense.maxChars : 1000;
    const lines = memory.split('\n');
    const kept = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (size + lines[i].length + 1 > limit) {
        break;
      }
      kept.unshift(lines[i]);
      size += lines[i].length + 1;
    }
    return `${kept.join('\n')}\n`;
  };

  // Feedback review (User Story 7): classify a note from its wording, the way a careful reviewer would.
  const classifyNote = (userPrompt) => {
    const match = /<untrusted source="feedback-note">\n([\s\S]*?)\n<\/untrusted>/.exec(userPrompt);
    const note = (match ? match[1] : '').toLowerCase();
    const host = (/host: ([a-z0-9.-]+)/.exec(userPrompt) || [])[1] || 'one project';
    if (/\buntil\b|\bexpected\b/.test(note)) {
      return { classification: 'expectation', title: 'Temporary expectation', lesson: 'A stated horizon.',
        projects_yaml: null, rationale: 'Handled by the horizon rule.' };
    }
    if (/normally|usually|baseline/.test(note)) {
      return {
        classification: 'project_annotation', title: 'Record the usual backlog level for this project',
        lesson: 'One project runs a higher sentinel backlog as a matter of course; annotate it so the analysis '
          + 'reads its baseline correctly.',
        projects_yaml: [
          'projects:', `  ${host}:`,
          '    notes: Sentinel backlog is normally around 300; a rise to three times that is the signal.', '',
        ].join('\n'),
        rationale: 'The note states a durable fact about one deployment, not a rule for every project.',
      };
    }
    if (/wording|bullet|too long|format/.test(note)) {
      return { classification: 'prompt', title: 'Shorter bullets with the comparison window first',
        lesson: 'Lead each bullet with the window compared, then the values.', projects_yaml: null,
        rationale: 'Readers asked for the comparison first.' };
    }
    if (/threshold|fires too often|noisy/.test(note)) {
      return { classification: 'threshold', title: 'Raise the percentage-change default',
        lesson: 'The default percentage-change rule fires on ordinary daily variation.', projects_yaml: null,
        rationale: 'Repeated dismissals on the same rule.' };
    }
    if (/interpret|means|skill|pattern/.test(note)) {
      return { classification: 'skill', title: 'Read a slow sentinel drain as recovery, not a new problem',
        lesson: 'A falling backlog after a fix is recovery and should not be flagged as a change.',
        projects_yaml: null, rationale: 'The skill lacks the recovery case.' };
    }
    return {
      classification: 'none', title: 'Thanks', lesson: '', projects_yaml: null, rationale: 'No reusable lesson.',
    };
  };

  const singleTurn = async (options) => {
    calls.singleTurns.push(options);
    if (options.name === 'feedback-review') {
      return {
        structuredOutput: classifyNote(options.userPrompt),
        result: result(),
        toolCalls: [],
        referenceUnavailable: false,
      };
    }
    if (options.name === 'memory-condense') {
      return {
        structuredOutput: { memory: condensed(options.userPrompt) },
        result: result(),
        toolCalls: [],
        referenceUnavailable: false,
      };
    }
    // Like a real model, write the brief from the ranked items the prompt carries (ids, hosts, evidence), so
    // whatever code did to identities before ranking (pattern-card matching, feedback) is respected.
    const rankedMatch = /<untrusted source="ranked-items">\n([\s\S]*?)\n<\/untrusted>/.exec(options.userPrompt);
    const ranked = rankedMatch ? JSON.parse(rankedMatch[1]) : [];
    const ordered = [...ranked].sort((a, b) => (a.rank || 0) - (b.rank || 0));
    const bullets = ordered.slice(0, 3).map((item) => {
      const cur = item.evidence.find((e) => e.window === 'current') || item.evidence[0];
      const prev = item.evidence.find((e) => e.window === 'previous_day');
      const now = briefMode === 'bad' ? '999999' : formatValue(cur.value, cur.unit);
      const before = prev ? ` vs ${formatValue(prev.value, prev.unit)} yesterday` : '';
      return { item_id: item.item_id, text: `${item.host} \`${item.metric}\`: ${now} now${before}` };
    });
    return {
      structuredOutput: {
        headline: `Watchdog brief: ${ordered.length} item${ordered.length === 1 ? '' : 's'} to look at`,
        bullets,
        thread_order: ordered.map((i) => i.item_id),
        expected_load_notice: null,
        memory_update: { replace_with: memoryText === undefined ? memoryFromFeedback() : memoryText },
        proposals,
      },
      result: result(),
      toolCalls: [],
      referenceUnavailable: false,
    };
  };

  return { openSession, singleTurn, calls };
};

const runCase = async ({
  caseName, dataDir, envExtra = {}, flags = {}, briefMode = 'good', date = DATE, runStart = null, slack = fakeSlack(),
  useTools = false, engine = undefined, proposals = [], memoryText = undefined, condense = null, historyDays = {},
  patternCards = undefined, definition = undefined,
}) => {
  const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', caseName), runStart, historyDays });
  const out = capture();
  const err = capture();
  const browserLauncher = fakeBrowserLauncher();
  // engine: undefined → the scripted model; false → none injected, so the run command builds the configured
  // engine itself (used to drive the real CLI engine against the fake claude executable).
  const scriptedEngine = engine === false
    ? undefined
    : (engine || createScriptedEngine({ dataDir, briefMode, useTools, proposals, memoryText, condense }));
  const args = {
    command: 'run',
    flags: { date, ...flags },
    positionals: [],
    env: envFor(dataDir, envExtra),
    stdout: out.stream,
    stderr: err.stream,
    logger: createLogger({ stream: err.stream, level: 'warn' }),
    deps: {
      fetch: fake.fetch,
      slack,
      browserLauncher,
      engine: scriptedEngine,
      tracer: fakeTracer(),
      gitSha: 'e2e',
      now: () => new Date(`${date}T06:05:00Z`),
      // Pattern cards and a definition built from another skill directory (User Story 6).
      ...(patternCards ? { patternCards } : {}),
      ...(definition ? { definition } : {}),
    },
  };
  let code;
  let error;
  try {
    code = await runCommand(args);
  } catch (e) {
    error = e;
  }
  const runId = fs.readdirSync(path.join(dataDir, 'runs')).sort().filter((id) => id.startsWith(date)).pop();
  const root = path.join(dataDir, 'runs', runId);
  if (process.env.E2E_KEEP) {
    fs.writeFileSync(path.join(root, 'stderr.log'), err.text());
  }
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  return { code, error, out, err, slack, browserLauncher, engine: scriptedEngine, fake, root, read, runId };
};

module.exports = {
  DATE, DEFAULTS_DIR, capture, envFor, fakeTracer, fakeSlack, fakeBrowserLauncher, createScriptedEngine, runCase,
};
