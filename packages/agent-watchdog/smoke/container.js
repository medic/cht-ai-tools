#!/usr/bin/env node
'use strict';
// Container contract checks (contracts/container.md, S-11): build the image, then prove `--version`, the readiness
// exit code for an unreachable host (69) and the report rendering with a read-only root filesystem and only /tmp
// writable. Needs Docker; nothing else. Usage: node smoke/container.js [--no-build] [--image <tag>]
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const imageArg = argv.indexOf('--image');
const image = imageArg !== -1 ? argv[imageArg + 1] : (process.env.AGENT_WATCHDOG_IMAGE || 'agent-watchdog:smoke');
const checks = [];

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
    const build = docker(['build', '-t', image, '.'], { stdio: ['ignore', 'inherit', 'inherit'] });
    record('image builds', build.status === 0, image);
    if (build.status !== 0) {
      process.exitCode = 1;
      return;
    }
  }

  const printed = docker(['run', '--rm', image, '--version']);
  const versionDetail = `got ${JSON.stringify(printed.stdout.trim())}, expected ${pkg.version}`;
  record('--version prints the package version', printed.stdout.trim() === pkg.version, versionDetail);

  const readiness = docker(['run', '--rm', '--read-only', '--tmpfs', '/tmp', image, 'check', 'https://example.invalid']);
  record('check of an unreachable host exits 69', readiness.status === 69, `exit ${readiness.status}`);

  const render = docker([
    'run', '--rm', '--read-only', '--tmpfs', '/tmp', '--user', '10001:10001',
    '-v', `${path.join(ROOT, 'smoke')}:/app/smoke:ro`,
    '--entrypoint', 'node', image, 'smoke/render.js', '--out', '/tmp/agent-watchdog-smoke/brief.png',
  ]);
  const renderDetail = (render.stdout || render.stderr).trim().split('\n').pop();
  record('report and image render with a read-only root filesystem (S-11)', render.status === 0, renderDetail);

  const failed = checks.filter((c) => !c.ok);
  process.exitCode = failed.length ? 1 : 0;
};

main();
