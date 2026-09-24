const fs = require('node:fs');
const path = require('node:path');
const check = require('../../src/cli/commands/check');
const codes = require('../../src/cli/exit-codes');
const { createLogger } = require('../../src/log/logger');
const { capture, DEFAULTS_DIR, attempt } = require('./helpers');
const { tempDir, removeDir } = require('../helpers/fixtures');

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const monitoring = (app) => ({ version: { app, node: 'v20.11.1', couchdb: '3.3.3' } });

// Deliberately minimal: the readiness check needs no Grafana, Slack, model or tracing configuration.
const envFor = (configDir = DEFAULTS_DIR) => ({
  AGENT_WATCHDOG_CONFIG_DIR: configDir, AGENT_WATCHDOG_DATA_DIR: '/tmp',
});

const argsFor = ({ positionals = [], fetch, configDir } = {}) => {
  const out = capture();
  const err = capture();
  return {
    out,
    err,
    args: {
      command: 'check',
      flags: {},
      positionals,
      env: envFor(configDir),
      stdout: out.stream,
      stderr: err.stream,
      logger: createLogger({ stream: err.stream, level: 'info' }),
      deps: { fetch, now: () => new Date('2026-09-18T09:00:00Z') },
    },
  };
};

describe('cli/commands/check', () => {
  it('exits 64 without a URL or with a malformed one', async () => {
    const missing = await attempt(check, argsFor({ fetch: sinon.stub() }).args);
    expect(missing.error.code).to.equal(codes.USAGE);
    expect(missing.error.message).to.match(/usage|URL/i);
    const malformed = await attempt(check, argsFor({ positionals: ['ftp://cht.example.org'], fetch: sinon.stub() }).args);
    expect(malformed.error.code).to.equal(codes.USAGE);
    const garbage = await attempt(check, argsFor({ positionals: ['not a url at all'], fetch: sinon.stub() }).args);
    expect(garbage.error.code).to.equal(codes.USAGE);
    // An http:// address is refused in words rather than probed over https behind the operator's back (revision 35).
    const fetch = sinon.stub();
    const plain = await attempt(check, argsFor({ positionals: ['http://cht.example.org'], fetch }).args);
    expect(plain.error.code).to.equal(codes.USAGE);
    expect(plain.error.message).to.match(/https/);
    expect(fetch.called).to.equal(false);
  });

  it('prints the report and exits 0 when every prerequisite is met, accepting a bare host', async () => {
    const fetch = sinon.stub().resolves(json(monitoring('4.11.0')));
    const t = argsFor({ positionals: ['cht.example.org'], fetch });
    const { code, error } = await attempt(check, t.args);
    expect(error).to.equal(null);
    expect(code).to.equal(0);
    expect(fetch).to.have.been.calledOnce;
    expect(fetch.firstCall.args[0]).to.equal('https://cht.example.org/api/v2/monitoring');
    expect(t.out.text()).to.include('Readiness of cht.example.org (CHT 4.11.0)');
    expect(t.out.text().trim().split('\n').pop()).to.equal('ready');
    const logged = t.err.text().split('\n').filter(Boolean).map(JSON.parse);
    const event = logged.find((l) => l.event === 'readiness.checked');
    expect(event).to.include({ host: 'cht.example.org', app: '4.11.0', ready: true });
  });

  it('exits 1 and names the unmet prerequisite for an instance below 3.12.0', async () => {
    const fetch = sinon.stub().resolves(json(monitoring('3.11.0')));
    const t = argsFor({ positionals: ['https://cht.example.org/'], fetch });
    const { code, error } = await attempt(check, t.args);
    expect(error).to.equal(null);
    expect(code).to.equal(codes.FAILED);
    expect(t.out.text()).to.include('UNMET');
    expect(t.out.text()).to.include('CHT 3.12.0 or later is required');
    expect(t.out.text().trim().split('\n').pop()).to.equal('not ready: 1 prerequisite unmet');
  });

  it('exits 69 when the host is unreachable', async () => {
    const fetch = sinon.stub().rejects(Object.assign(new Error('fetch failed'), { name: 'TypeError' }));
    const { code, error } = await attempt(check, argsFor({ positionals: ['https://cht.example.org'], fetch }).args);
    expect(code).to.equal(null);
    expect(error.code).to.equal(codes.UNAVAILABLE);
    expect(error.message).to.include('monitoring endpoint unreachable');
  });

  describe('with host_metrics enabled in projects.yaml', () => {
    let configDir;
    beforeEach(() => {
      configDir = tempDir();
      fs.writeFileSync(path.join(configDir, 'projects.yaml'), [
        'projects:',
        '  cht.example.org:',
        '    host_metrics: true',
        '',
      ].join('\n'));
    });
    afterEach(() => removeDir(configDir));

    it('probes port 8443 and exits 1 when the exporter does not answer', async () => {
      const fetch = sinon.stub().callsFake(async (url) => {
        if (url.includes(':8443')) {
          throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
        }
        return json(monitoring('4.11.0'));
      });
      const t = argsFor({ positionals: ['https://cht.example.org'], fetch, configDir });
      const { code, error } = await attempt(check, t.args);
      expect(error).to.equal(null);
      expect(code).to.equal(codes.FAILED);
      expect(fetch).to.have.been.calledTwice;
      expect(fetch.secondCall.args[0]).to.equal('https://cht.example.org:8443/metrics');
      expect(t.out.text()).to.include('host-metrics exporter');
    });

    it('does not probe a project that is not annotated', async () => {
      const fetch = sinon.stub().resolves(json(monitoring('4.11.0')));
      const { code } = await attempt(check, argsFor({ positionals: ['https://other.example.org'], fetch, configDir }).args);
      expect(code).to.equal(0);
      expect(fetch).to.have.been.calledOnce;
    });
  });
});
