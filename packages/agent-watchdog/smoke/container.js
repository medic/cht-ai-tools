#!/usr/bin/env node
'use strict';
// Container contract checks (contracts/container.md, S-50, SC-017): build the image, then run it as the platform
// will, root filesystem read-only, every capability dropped, no privilege escalation, user 10001:10001, and no
// network where none is needed, and prove `--version`, `egress`, the readiness exit code for an unreachable host (69)
// and the report rendering under /tmp alone. Needs Docker; nothing else.
// Usage: node smoke/container.js [--no-build] [--image <tag>]
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const imageArg = argv.indexOf('--image');
const image = imageArg !== -1 ? argv[imageArg + 1] : (process.env.AGENT_WATCHDOG_IMAGE || 'agent-watchdog:smoke');
const checks = [];

// The constraints the deployment applies (FR-086).
const HARDENED = [
  '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001',
];
const PLACEHOLDER_ENV = [
  '-e', 'AGENT_WATCHDOG_GRAFANA_URL=https://watchdog.example.org',
  '-e', 'LANGFUSE_BASE_URL=https://langfuse.example.org',
  '-e', 'AGENT_WATCHDOG_DOCS_MCP_URL=https://docs-mcp.example.org/mcp',
];

const record = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

const docker = (args, options = {}) => spawnSync('docker', args, {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options,
});

const main = () => {
  const version = docker(['--version']);
  if (version.status !== 0) {
    console.error('FAIL docker is not available on this machine');
    process.exitCode = 1;
    return;
  }
  if (!argv.includes('--no-build')) {
    const build = docker([
      'build', '--build-arg', `VERSION=${pkg.version}`, '--build-arg', 'REVISION=smoke', '-t', image, '.',
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    record('image builds', build.status === 0, image);
    if (build.status !== 0) {
      process.exitCode = 1;
      return;
    }
  }

  const printed = docker(['run', '--rm', '--network', 'none', ...HARDENED, image, '--version']);
  const versionDetail = `got ${JSON.stringify(printed.stdout.trim())}, expected ${pkg.version}`;
  record(
    '--version prints the package version with no network and a read-only root',
    printed.stdout.trim() === pkg.version,
    versionDetail,
  );

  const egress = docker([
    'run', '--rm', '--network', 'none', ...HARDENED, ...PLACEHOLDER_ENV, image, 'egress', '--format', 'hosts',
  ]);
  const hosts = egress.stdout.trim().split('\n');
  const expectedHosts = ['watchdog.example.org', 'slack.com', 'api.anthropic.com', 'langfuse.example.org'];
  const egressOk = egress.status === 0 && expectedHosts.every((host) => hosts.includes(host));
  record(
    'egress lists the destinations for the configuration',
    egressOk,
    `${hosts.length} hosts, exit ${egress.status}`,
  );

  const readiness = docker(['run', '--rm', '--network', 'none', ...HARDENED, image, 'check', 'https://example.invalid']);
  record('check of an unreachable host exits 69', readiness.status === 69, `exit ${readiness.status}`);

  const render = docker([
    'run', '--rm', '--network', 'none', ...HARDENED,
    '-v', `${path.join(ROOT, 'smoke')}:/app/smoke:ro`,
    '--entrypoint', 'node', image, 'smoke/render.js', '--out', '/tmp/agent-watchdog-smoke/report.html',
  ]);
  const renderDetail = (render.stdout || render.stderr).trim().split('\n').pop();
  record(
    'the report renders with a read-only root filesystem, writing under /tmp (S-11)',
    render.status === 0,
    renderDetail,
  );

  const whoami = docker(['run', '--rm', '--network', 'none', ...HARDENED, '--entrypoint', 'id', image, '-u']);
  record('the process runs as uid 10001', whoami.stdout.trim() === '10001', `uid ${whoami.stdout.trim()}`);

  const failed = checks.filter((c) => !c.ok);
  process.exitCode = failed.length ? 1 : 0;
};

main();
