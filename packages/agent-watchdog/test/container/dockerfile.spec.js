// FR-086 (revision 30): the image definition, read as text so no Docker is needed in the unit suite.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('container: the image definition (FR-086, contracts/container.md)', () => {
  const dockerfile = read('Dockerfile');
  const lines = dockerfile.split('\n');

  it('builds from the pinned Node 22 slim base in two stages from the lockfile, without lifecycle scripts', () => {
    expect(lines.filter((l) => l.startsWith('FROM '))).to.deep.equal([
      'FROM node:22-bookworm-slim AS deps', 'FROM node:22-bookworm-slim',
    ]);
    expect(dockerfile).to.include('COPY package.json package-lock.json ./');
    expect(dockerfile).to.match(/npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
    expect(dockerfile).to.not.match(/\bnpm install\b/);
  });

  it('carries no browser, uses no package manager at run time and disables the runtime\'s telemetry', () => {
    expect(dockerfile).to.not.match(/playwright|chromium|PLAYWRIGHT_BROWSERS_PATH|apt-get|fonts-noto/i);
    for (const env of [
      'NODE_ENV=production', 'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'CLAUDE_CONFIG_DIR=/tmp/agent-watchdog-runtime',
      'HOME=/home/watchdog', 'TMPDIR=/tmp',
    ]) {
      expect(dockerfile, env).to.include(env);
    }
  });

  it('runs as the fixed non-root user owning /data alone, exposes no port and starts the CLI', () => {
    expect(lines).to.include('USER 10001:10001');
    expect(dockerfile).to.include(
      'groupadd -g 10001 watchdog && useradd -u 10001 -g 10001 -d /home/watchdog -m -s /usr/sbin/nologin watchdog',
    );
    expect(dockerfile).to.include(
      'mkdir -p /data /home/watchdog/.claude && chown -R watchdog:watchdog /data /home/watchdog',
    );
    expect(dockerfile).to.not.match(/chown -R [^\n]*\/app/);
    expect(dockerfile).to.not.match(/^EXPOSE/m);
    expect(dockerfile).to.not.match(/^VOLUME/m);
    expect(lines).to.include('ENTRYPOINT ["node", "bin/agent-watchdog.js"]');
    expect(lines).to.include('CMD ["--help"]');
    const copied = lines.filter((l) => l.startsWith('COPY ') && !l.startsWith('COPY --from'))
      .flatMap((l) => l.split(/\s+/).slice(1, -1));
    expect(copied).to.include.members([
      'bin', 'src', 'agent', 'prompts', 'skill', 'schema', 'templates', 'config/defaults',
    ]);
    const excluded = /^(test|specs|smoke|scripts|deploy|data|config\/local|\.env|payload)/;
    expect(copied.some((s) => excluded.test(s))).to.equal(false);
  });

  it('puts the Agent SDK\'s own Claude Code binary on PATH as claude for the CLI engine and the local login', () => {
    expect(dockerfile).to.include(
      'test -x /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    );
    expect(dockerfile).to.include(
      'ln -s /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /usr/local/bin/claude',
    );
    expect(dockerfile).to.not.match(/npm install -g|@anthropic-ai\/claude-code/);
  });

  it('labels the image with its source, licence, version and revision from build arguments', () => {
    expect(lines).to.include('ARG VERSION=0.0.0-development');
    expect(lines).to.include('ARG REVISION=unknown');
    expect(dockerfile).to.include('org.opencontainers.image.source="https://github.com/medic/cht-ai-tools"');
    expect(dockerfile).to.include('org.opencontainers.image.licenses="AGPL-3.0"');
    expect(dockerfile).to.include('org.opencontainers.image.version="${VERSION}"');
    expect(dockerfile).to.include('org.opencontainers.image.revision="${REVISION}"');
    const release = read('release.config.js');
    expect(release).to.include('--build-arg VERSION=${nextRelease.version}');
    expect(release).to.include('--build-arg REVISION=${nextRelease.gitHead}');
  });

  it('keeps tests, specifications, secrets, data, the manifests and local policy out of the build context', () => {
    const ignored = read('.dockerignore').split('\n').map((l) => l.trim()).filter(Boolean);
    for (const entry of [
      'node_modules', '.env', '.env.*', 'test', 'specs', 'smoke', 'scripts', 'data', 'config/local', 'deploy',
      'payload*.json', '.design-scratch', 'coverage', '.git', 'Dockerfile',
    ]) {
      expect(ignored, entry).to.include(entry);
    }
    expect(ignored).to.include('!.env.example');
  });

  it('has no browser dependency and no browser module left', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys(pkg.dependencies)).to.not.include('playwright-core');
    expect(Object.keys(pkg.devDependencies)).to.not.include('playwright-core');
    expect(fs.existsSync(path.join(ROOT, 'src', 'render', 'browser.js'))).to.equal(false);
    const lock = read('package-lock.json');
    expect(lock).to.not.include('playwright');
    expect(read('.env.example')).to.not.include('CHROMIUM');
  });
});
