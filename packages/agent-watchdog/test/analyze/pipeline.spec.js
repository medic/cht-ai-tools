const path = require('node:path');
const fs = require('node:fs');
const collect = require('../../src/cli/stages/collect');
const analyze = require('../../src/cli/stages/analyze');
const { loadPolicy } = require('../../src/config/policy');
const { RunDir } = require('../../src/store/run-dir');
const { createLogger } = require('../../src/log/logger');
const codes = require('../../src/cli/exit-codes');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath, loadJson, tempDir, removeDir } = require('../helpers/fixtures');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const RUN_START = new Date('2026-09-18T06:00:00Z');
const quiet = createLogger({ level: 'error', stream: { write() {} } });

const contextFor = async (caseName, flags = {}, { projectsYaml = null } = {}) => {
  const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', caseName) });
  const dataDir = tempDir();
  const configDir = tempDir();
  if (projectsYaml) {
    fs.writeFileSync(path.join(configDir, 'projects.yaml'), projectsYaml);
  }
  const policy = loadPolicy({ configDir, defaultsDir: DEFAULTS_DIR });
  const runDir = await RunDir.create(dataDir, '2026-09-18');
  const config = {
    endpoints: { grafanaUrl: fake.baseUrl, prometheusDatasourceUid: fake.datasourceUid },
    secrets: { grafanaToken: fake.token },
    bounds: { httpTimeoutMs: 1000 },
    storage: { configDir },
    paths: { defaultsDir: DEFAULTS_DIR },
  };
  const ctx = {
    config, policy, logger: quiet, runDir, runId: '2026-09-18', date: '2026-09-18', runStart: RUN_START, flags,
    deps: { fetch: fake.fetch },
  };
  return { ctx, fake, dataDir, configDir, runDir, cleanup: () => {
    removeDir(dataDir);
    removeDir(configDir);
  } };
};

describe('collect and analyze pipeline over the recorded fixtures', () => {
  for (const caseName of ['seeded-anomaly', 'quiet-day']) {
    describe(caseName, () => {
      let env;
      let candidates;
      before(async () => {
        env = await contextFor(caseName);
        const collected = await collect.run(env.ctx);
        expect(collected.projects).to.equal(3);
        expect(collected.metrics).to.be.greaterThan(10);
        const analysed = await analyze.run(env.ctx);
        expect(analysed.projects).to.equal(3);
        candidates = [];
        for (const slug of ['alpha-example-org', 'beta-example-org', 'gamma-example-org']) {
          candidates.push(...await env.runDir.readJson(`${slug}/candidates.json`));
        }
      });
      after(() => env.cleanup());

      it('writes the stage files of the run-directory contract', () => {
        expect(env.runDir.exists('discovery.json')).to.equal(true);
        for (const slug of ['alpha-example-org', 'beta-example-org', 'gamma-example-org']) {
          expect(env.runDir.exists(`${slug}/inputs/windows.json.gz`), slug).to.equal(true);
          expect(env.runDir.exists(`${slug}/changes.json`), slug).to.equal(true);
          expect(env.runDir.exists(`${slug}/candidates.json`), slug).to.equal(true);
        }
        expect(fs.readdirSync(env.runDir.root).some((f) => f.endsWith('.tmp'))).to.equal(false);
      });

      it('matches expected.json', () => {
        const expected = loadJson('runs', caseName, 'expected.json');
        if (expected.quiet) {
          expect(candidates).to.deep.equal([]);
          return;
        }
        for (const want of expected.candidates) {
          const matching = candidates.filter((c) => c.project_url === `https://${want.host}` && c.metric.includes(want.metric_contains));
          expect(matching.map((c) => c.rule), `${want.host} ${want.metric_contains}`).to.include.members(want.rules);
          expect(matching.every((c) => c.severity_floor === want.severity_floor), `${want.host} floor`).to.equal(true);
        }
        const hosts = new Set(candidates.map((c) => c.project_url));
        expect(hosts.has('https://beta.example.org')).to.equal(false);
      });
    });
  }

  it('restricts collection to the projects named with --project', async () => {
    const env = await contextFor('quiet-day', { project: ['alpha.example.org'] });
    try {
      const result = await collect.run(env.ctx);
      expect(result.projects).to.equal(1);
      expect(env.runDir.exists('alpha-example-org/inputs/windows.json.gz')).to.equal(true);
      expect(env.runDir.exists('beta-example-org/inputs/windows.json.gz')).to.equal(false);
      const discovery = await env.runDir.readJson('discovery.json');
      expect(discovery.projects).to.have.length(3);
    } finally {
      env.cleanup();
    }
  });

  it('refuses to analyze a project whose windows are missing (exit 65)', async () => {
    const env = await contextFor('quiet-day', { project: ['alpha.example.org'] });
    try {
      await collect.run(env.ctx);
      await expect(analyze.run({ ...env.ctx, flags: {} })).to.be.rejectedWith(codes.ExitError)
        .and.eventually.have.property('code', codes.DATAERR);
    } finally {
      env.cleanup();
    }
  });

  it('fails the collect stage with exit 78 when the datasource uid does not match the dashboards', async () => {
    const env = await contextFor('quiet-day');
    try {
      env.ctx.config.endpoints.prometheusDatasourceUid = 'PXXXXXXXXXXXXXXXX';
      await expect(collect.run(env.ctx)).to.be.rejectedWith(codes.ExitError)
        .and.eventually.have.property('code', codes.CONFIG);
    } finally {
      env.cleanup();
    }
  });
  it('discovers an ignored host but gives it no project directory, windows or candidates (FR-068)', async () => {
    const env = await contextFor('seeded-anomaly', {}, { projectsYaml: "projects: {}\nignore: ['gamma*']\n" });
    try {
      const collected = await collect.run(env.ctx);
      expect(collected.projects).to.equal(2);
      const discovery = await env.runDir.readJson('discovery.json');
      expect(discovery.projects.map((p) => p.host)).to.deep.equal(['alpha.example.org', 'beta.example.org']);
      expect(discovery.ignored).to.deep.equal([{ host: 'gamma.example.org', pattern: 'gamma*' }]);
      expect(fs.existsSync(path.join(env.runDir.root, 'gamma-example-org'))).to.equal(false);
      const analysed = await analyze.run(env.ctx);
      expect(analysed.projects).to.equal(2);
      expect(env.runDir.exists('gamma-example-org/candidates.json')).to.equal(false);
    } finally {
      env.cleanup();
    }
  });
});
