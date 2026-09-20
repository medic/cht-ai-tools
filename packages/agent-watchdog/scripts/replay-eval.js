#!/usr/bin/env node
'use strict';
// Replay evaluation: the regression gate for prompt, skill and analysis changes (constitution II, Quality
// Gates; `npm run replay:eval`). Every fixture day under test/fixtures/runs/<case>/ is run through the real
// collect and analyze stages against the fake Grafana, the recorded model findings are put through the
// verification gate offline, and the results are compared with expected.json and the labelled feedback set.
// Development-only: it deliberately requires the test helpers (the fake Grafana and the fixture paths).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config/load');
const { createLogger } = require('../src/log/logger');
const { createContext } = require('../src/cli/context');
const { RunDir, ensureDataLayout } = require('../src/store/run-dir');
const { createGrafanaClient } = require('../src/collect/grafana');
const collectStage = require('../src/cli/stages/collect');
const analyzeStage = require('../src/cli/stages/analyze');
const { verifyFindings } = require('../src/verify/gate');
const { buildAllowlist } = require('../src/links/allowlist');
const { createFakeGrafana } = require('../test/helpers/fake-grafana');

const PACKAGE_ROOT = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(PACKAGE_ROOT, 'test', 'fixtures');
const DEFAULTS_DIR = path.join(PACKAGE_ROOT, 'config', 'defaults');
const FINDINGS_FILE = /^(.+)\.pass(\d+)\.json$/;

// Placeholders for the values the collect and analyze stages validate at startup; nothing here is contacted.
const envFor = (dataDir) => ({
  ANTHROPIC_API_KEY: 'sk-ant-replay-eval',
  SLACK_BOT_TOKEN: 'xoxb-replay-eval',
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
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const listCases = (fixturesDir = FIXTURES_DIR) => fs
  .readdirSync(path.join(fixturesDir, 'runs'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(fixturesDir, 'runs', entry.name, 'expected.json')))
  .map((entry) => entry.name)
  .sort();

/**
 * Run the deterministic half of the pipeline for one fixture day.
 * @returns {Promise<{ runDir, discovery, projects, config, date }>} projects carry changes, candidates and windows
 */
const analyseCase = async ({ fixturesDir = FIXTURES_DIR, caseName, dataDir, logger }) => {
  const fixtureDir = path.join(fixturesDir, 'runs', caseName);
  const fake = createFakeGrafana({ fixtureDir });
  const runStart = new Date(fake.runStart * 1000);
  const date = runStart.toISOString().slice(0, 10);
  const env = envFor(dataDir);
  const { config, effective, policy } = loadConfig({ env, flags: { date, 'dry-run': true }, command: 'run' });
  await ensureDataLayout(dataDir);
  const runDir = await RunDir.create(dataDir, date);
  const grafana = createGrafanaClient({
    baseUrl: fake.baseUrl,
    token: fake.token,
    datasourceUid: fake.datasourceUid,
    timeoutMs: config.bounds.httpTimeoutMs,
    fetch: fake.fetch,
    logger,
  });
  const ctx = createContext({
    config, effective, policy, logger, runDir, runId: date, date, mode: 'replay', flags: {},
  });
  ctx.deps = { grafana };
  ctx.runStart = runStart;
  await collectStage.run(ctx.forStage('collect'));
  await analyzeStage.run(ctx.forStage('analyze'));

  const discovery = await runDir.readJson('discovery.json');
  const projects = [];
  for (const project of discovery.projects) {
    const stored = await runDir.readGz(`${project.slug}/inputs/windows.json.gz`);
    projects.push({
      ...project,
      changes: await runDir.readJson(`${project.slug}/changes.json`),
      candidates: await runDir.readJson(`${project.slug}/candidates.json`),
      windows: Array.isArray(stored) ? stored : stored.windows || [],
    });
  }
  return { runDir, discovery, projects, config, date };
};

const hostOf = (projectUrl) => {
  try {
    return new URL(projectUrl).host;
  } catch {
    return String(projectUrl);
  }
};

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Compare raised candidates ({ host, metric, rule, severity_floor }) with expected.json entries. */
const compareCandidates = ({ expected = [], actual = [] }) => {
  const missing = [];
  const mismatched = [];
  const covered = new Set();
  for (const want of expected) {
    const matching = actual.filter((c) => c.host === want.host && c.metric.includes(want.metric_contains));
    if (!matching.length) {
      missing.push(want);
      continue;
    }
    for (const c of matching) {
      covered.add(`${c.host}|${c.metric}`);
    }
    const reasons = [];
    const rules = matching.map((c) => c.rule);
    if (!sameSet(rules, want.rules)) {
      reasons.push(`rules ${JSON.stringify([...rules].sort())} differ from ${JSON.stringify([...want.rules].sort())}`);
    }
    const floors = [...new Set(matching.map((c) => c.severity_floor))];
    if (floors.length !== 1 || floors[0] !== want.severity_floor) {
      reasons.push(`severity_floor ${JSON.stringify(floors)} differs from ${want.severity_floor}`);
    }
    if (reasons.length) {
      mismatched.push({ ...want, reasons });
    }
  }
  const unexpected = [];
  const seen = new Set();
  for (const c of actual) {
    const key = `${c.host}|${c.metric}`;
    if (!covered.has(key) && !seen.has(key)) {
      seen.add(key);
      unexpected.push({ host: c.host, metric: c.metric });
    }
  }
  return { expected: expected.length, actual: actual.length, missing, unexpected, mismatched };
};

/** A confirmed label must be among the accepted items of its case; a dismissed label must not. */
const checkLabels = ({ caseName, labels = [], items = [] }) => labels
  .filter((label) => label.case === caseName)
  .map((label) => {
    const present = items.some((item) => item.host === label.host && item.metric === label.metric);
    const satisfied = label.verdict === 'confirmed' ? present : !present;
    return { label, satisfied };
  });

const recordedFindings = (fixtureDir) => {
  const dir = path.join(fixtureDir, 'findings');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .map((file) => FINDINGS_FILE.exec(file))
    .filter(Boolean)
    .map((match) => ({ slug: match[1], pass: Number(match[2]), findings: readJson(path.join(dir, match[0])) }))
    .sort((a, b) => a.slug.localeCompare(b.slug) || a.pass - b.pass);
};

const itemView = (item) => ({ host: hostOf(item.project_url), metric: item.metric, severity: item.severity });

const itemKey = (view) => `${view.host}|${view.metric}|${view.severity}`;

const compareItems = ({ expected = [], actual = [] }) => {
  const actualKeys = new Set(actual.map(itemKey));
  const expectedKeys = new Set(expected.map(itemKey));
  return {
    expected,
    actual,
    missing: expected.filter((i) => !actualKeys.has(itemKey(i))),
    unexpected: actual.filter((i) => !expectedKeys.has(itemKey(i))),
  };
};

const evaluateCase = async ({ fixturesDir, caseName, labels, logger }) => {
  const fixtureDir = path.join(fixturesDir, 'runs', caseName);
  const expected = readJson(path.join(fixtureDir, 'expected.json'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-watchdog-replay-eval-'));
  try {
    const analysed = await analyseCase({ fixturesDir, caseName, dataDir, logger });
    const actualCandidates = analysed.projects.flatMap((p) => p.candidates.map((c) => ({
      host: p.host, metric: c.metric, rule: c.rule, severity_floor: c.severity_floor,
    })));
    const candidates = compareCandidates({ expected: expected.candidates || [], actual: actualCandidates });

    const gate = [];
    const acceptedItems = [];
    const allowlist = buildAllowlist(analysed.config);
    for (const recorded of recordedFindings(fixtureDir)) {
      const project = analysed.projects.find((p) => p.slug === recorded.slug);
      if (!project) {
        gate.push({ project: recorded.slug, outcome: 'unknown project', expected: null, failing: [] });
        continue;
      }
      const verdict = await verifyFindings({
        findings: recorded.findings,
        pass: recorded.pass,
        project,
        discovery: analysed.discovery,
        changes: project.changes,
        candidates: project.candidates,
        windows: project.windows,
        toolResultUrls: new Set(),
        knownCards: [],
        allowlist,
        attempt: 1,
        resolveLinks: null,
        grafanaUrl: analysed.config.endpoints.grafanaUrl,
      });
      const failing = verdict.report.checks.filter((c) => c.status === 'fail').map((c) => c.name);
      const want = expected.gate && expected.gate[recorded.slug] !== undefined ? expected.gate[recorded.slug] : null;
      gate.push({
        project: recorded.slug, pass: recorded.pass, outcome: verdict.report.outcome, expected: want, failing,
      });
      if (verdict.report.outcome === 'accepted') {
        acceptedItems.push(...verdict.items.map(itemView));
      }
    }
    const items = compareItems({ expected: expected.items || [], actual: acceptedItems });
    const labelResults = checkLabels({ caseName, labels, items: acceptedItems });

    const quietOk = expected.quiet === undefined || expected.quiet === (actualCandidates.length === 0);
    const gateOk = gate.every((g) => g.expected !== null && g.outcome === g.expected);
    const ok = quietOk
      && candidates.missing.length === 0 && candidates.unexpected.length === 0 && candidates.mismatched.length === 0
      && gateOk && items.missing.length === 0 && items.unexpected.length === 0
      && labelResults.every((l) => l.satisfied);
    return { case: caseName, quiet: actualCandidates.length === 0, candidates, gate, items, labels: labelResults, ok };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
};

/**
 * @param {object} [options]
 * @param {string} [options.fixturesDir] defaults to test/fixtures
 * @param {string[]} [options.cases] defaults to every case under runs/ with an expected.json
 * @param {object} [options.log] logger; defaults to warnings on stderr
 */
const evaluate = async ({ fixturesDir = FIXTURES_DIR, cases = null, log = null } = {}) => {
  const logger = log || createLogger({ level: 'warn', stream: process.stderr });
  const labelsFile = path.join(fixturesDir, 'feedback-labels.json');
  const labels = fs.existsSync(labelsFile) ? readJson(labelsFile).labels || [] : [];
  const names = cases || listCases(fixturesDir);
  const results = [];
  for (const caseName of names) {
    results.push(await evaluateCase({ fixturesDir, caseName, labels, logger }));
  }
  return { ok: results.every((r) => r.ok), cases: results };
};

const main = async () => {
  const report = await evaluate();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  evaluate, evaluateCase, analyseCase, compareCandidates, compareItems, checkLabels, recordedFindings, listCases,
  envFor, FIXTURES_DIR,
};
