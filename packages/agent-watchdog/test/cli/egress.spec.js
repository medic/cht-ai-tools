// `agent-watchdog egress` (FR-083, revision 30): the destinations a run contacts, for the platform's network policy.
const egress = require('../../src/cli/commands/egress');
const codes = require('../../src/cli/exit-codes');
const { createLogger } = require('../../src/log/logger');
const { capture, envFor, attempt } = require('./helpers');

const argsFor = ({ env, flags = {} } = {}) => {
  const out = capture();
  const err = capture();
  return {
    out,
    err,
    args: {
      command: 'egress', flags, positionals: [], env, stdout: out.stream, stderr: err.stream,
      logger: createLogger({ stream: err.stream, level: 'info' }),
    },
  };
};

describe('cli/commands/egress', () => {
  it('prints the allow-list as JSON from the effective configuration, without any secret, and exits 0', async () => {
    const t = argsFor({ env: envFor('/tmp') });
    expect(await egress(t.args)).to.equal(codes.OK);
    const document = JSON.parse(t.out.text());
    expect(document.inbound).to.equal('none');
    expect(document.endpoints.map((e) => e.host)).to.include.members([
      'watchdog.example.org', 'slack.com', 'files.slack.com', 'api.anthropic.com', 'langfuse.example.org',
      'docs-mcp.example.org', 'github.com', 'docs.communityhealthtoolkit.org', 'forum.communityhealthtoolkit.org',
    ]);
    expect(document.endpoints.every((e) => e.port === 443 && e.purposes.length > 0)).to.equal(true);
    expect(t.out.text()).to.not.match(/glsa_test|xoxb-test|sk-ant-test/);
    expect(t.err.text()).to.include('egress.listed');
  });

  it('needs neither secrets nor endpoints: the fixed destinations alone, exit 0', async () => {
    const t = argsFor({ env: {} });
    expect(await egress(t.args)).to.equal(codes.OK);
    const document = JSON.parse(t.out.text());
    expect(document.endpoints.map((e) => e.host).sort()).to.deep.equal([
      'api.anthropic.com', 'docs.communityhealthtoolkit.org', 'files.slack.com', 'forum.communityhealthtoolkit.org',
      'github.com', 'slack.com',
    ]);
  });

  it('prints one host per line, sorted, with --format hosts', async () => {
    const t = argsFor({ env: envFor('/tmp'), flags: { format: 'hosts' } });
    expect(await egress(t.args)).to.equal(codes.OK);
    const lines = t.out.text().trim().split('\n');
    expect(lines).to.deep.equal([...lines].sort());
    expect(lines).to.include('watchdog.example.org').and.include('slack.com');
    expect(new Set(lines).size).to.equal(lines.length);
  });

  it('rejects an unknown format as a usage error', async () => {
    const { error } = await attempt(egress, argsFor({ env: envFor('/tmp'), flags: { format: 'yaml' } }).args);
    expect(error.code).to.equal(codes.USAGE);
    expect(error.message).to.include('yaml');
  });
});
