#!/usr/bin/env node
'use strict';
// Smoke tests S-3 and S-10 (research.md; US3 scenario 7): one recorded project replayed through both engines,
// the SDK and `claude -p`, from the same agent definition. Items and gate verdicts must agree once the passes
// are normalised; prose (why_now, suggested_check) is excluded because two live model calls word things
// differently. Needs ANTHROPIC_API_KEY and a stored run. Costs a few cents.
// Usage: node --env-file=.env smoke/agent-parity.js --date <YYYY-MM-DD> --project <host>
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { Writable } = require('node:stream');

const ENGINES = ['sdk', 'cli'];
const FINDINGS_FILE = /^findings\.pass(\d+)\.json$/;

const roundSig = (value, digits = 3) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
    return value;
  }
  return Number(value.toPrecision(digits));
};

const sortBy = (list, key) => [...list].sort((a, b) => key(a).localeCompare(key(b)));

const normaliseItem = (item) => ({
  item_key: item.item_key
    || { metric: item.metric, pattern_card: item.pattern_card === undefined ? null : item.pattern_card },
  severity: item.severity,
  evidence: sortBy((item.evidence || []).map((e) => ({ window: e.window, value: roundSig(e.value), unit: e.unit })),
    (e) => `${e.window}|${e.unit}`),
  candidate_ids: [...(item.candidate_ids || [])].sort(),
  reference_urls: [...(item.reference_urls || [])].sort(),
  dashboard_ref: item.dashboard_ref
    ? { dashboard_uid: item.dashboard_ref.dashboard_uid, panel_id: item.dashboard_ref.panel_id }
    : null,
});

const itemLabel = (item) => (item.item_key.pattern_card
  ? `${item.item_key.metric}#${item.item_key.pattern_card}`
  : item.item_key.metric);

/** A pass reduced to what both engines must agree on. */
const normaliseFindings = (pass) => ({
  pass: pass.pass,
  items: sortBy((pass.items || []).map(normaliseItem), itemLabel),
  gate: pass.gate
    ? {
      outcome: pass.gate.outcome,
      failing: (pass.gate.checks || []).filter((c) => c.status === 'fail').map((c) => c.name).sort(),
    }
    : null,
});

const gateText = (gate) => {
  if (!gate) {
    return 'none';
  }
  return gate.failing.length ? `${gate.outcome} (${gate.failing.join(', ')})` : gate.outcome;
};

/**
 * @param {{ engine: string, passes: object[] }} a normalised passes of one engine
 * @param {{ engine: string, passes: object[] }} b the other engine
 * @returns {{ same: boolean, differences: string[] }}
 */
const diffEngines = (a, b) => {
  const differences = [];
  if (a.passes.length !== b.passes.length) {
    differences.push(`pass count: ${a.engine} ${a.passes.length} vs ${b.engine} ${b.passes.length}`);
  }
  const shared = Math.min(a.passes.length, b.passes.length);
  for (let i = 0; i < shared; i += 1) {
    const left = a.passes[i];
    const right = b.passes[i];
    const label = `pass ${left.pass}`;
    const leftItems = new Map(left.items.map((item) => [itemLabel(item), item]));
    const rightItems = new Map(right.items.map((item) => [itemLabel(item), item]));
    for (const [key, item] of leftItems) {
      if (!rightItems.has(key)) {
        differences.push(`${label} item only in ${a.engine}: ${key}`);
      } else if (JSON.stringify(item) !== JSON.stringify(rightItems.get(key))) {
        differences.push(`${label} item ${key} differs between ${a.engine} and ${b.engine}`);
      }
    }
    for (const key of rightItems.keys()) {
      if (!leftItems.has(key)) {
        differences.push(`${label} item only in ${b.engine}: ${key}`);
      }
    }
    if (JSON.stringify(left.gate) !== JSON.stringify(right.gate)) {
      differences.push(`${label} gate: ${a.engine} ${gateText(left.gate)} vs ${b.engine} ${gateText(right.gate)}`);
    }
  }
  return { same: differences.length === 0, differences };
};

const loadPasses = (projectDir) => fs.readdirSync(projectDir)
  .map((file) => FINDINGS_FILE.exec(file))
  .filter(Boolean)
  .sort((x, y) => Number(x[1]) - Number(y[1]))
  .map((match) => JSON.parse(fs.readFileSync(path.join(projectDir, match[0]), 'utf8')));

const sink = () => new Writable({ write(chunk, encoding, callback) {
  callback(); 
} });

const main = async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { date: { type: 'string' }, project: { type: 'string' } },
    strict: true,
  });
  if (!values.date || !values.project) {
    console.error('usage: node smoke/agent-parity.js --date <YYYY-MM-DD> --project <host>');
    process.exitCode = 64;
    return;
  }
  const { loadConfig } = require('../src/config/load');
  const { createLogger } = require('../src/log/logger');
  const { RunDir } = require('../src/store/run-dir');
  const { projectSlug } = require('../src/model/identity');
  const { normaliseHost } = require('../src/config/policy');
  const replay = require('../src/cli/commands/replay');

  const host = normaliseHost(values.project);
  const logger = createLogger({ level: 'info', format: 'pretty' });
  const { config } = loadConfig({ command: 'replay', flags: { date: values.date } });
  const dataDir = config.storage.dataDir;
  const runIds = (await RunDir.list(dataDir)).filter((id) => id.startsWith(values.date));
  if (!runIds.length) {
    console.error(`no stored run for ${values.date} under ${dataDir}`);
    process.exitCode = 65;
    return;
  }
  const runId = runIds[runIds.length - 1];
  const results = [];
  for (const engine of ENGINES) {
    const label = `parity-${engine}`;
    console.log(`replaying ${runId} for ${host} through the ${engine} engine as ${label}`);
    await replay({
      command: 'replay',
      flags: { date: runId, project: [host], label, engine, compare: false },
      positionals: [],
      env: process.env,
      stdout: sink(),
      stderr: process.stderr,
      logger,
    });
    const projectDir = path.join(dataDir, 'runs-replay', runId, label, projectSlug(host));
    results.push({ engine, passes: loadPasses(projectDir).map(normaliseFindings) });
  }
  const [sdk, cli] = results;
  const diff = diffEngines(sdk, cli);
  for (const engine of results) {
    console.log(`${engine.engine}: ${engine.passes.length} pass(es), `
      + `${engine.passes.map((p) => `${p.items.length} item(s) ${gateText(p.gate)}`).join('; ')}`);
  }
  if (diff.same) {
    console.log('ok   both engines produced the same items and gate verdicts (S-3, S-10)');
  } else {
    for (const difference of diff.differences) {
      console.log(`FAIL ${difference}`);
    }
  }
  process.exitCode = diff.same ? 0 : 1;
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { normaliseFindings, normaliseItem, diffEngines, loadPasses, ENGINES };
