const fs = require('node:fs');
const path = require('node:path');
const { collectVersions, resolveGitSha, definitionHashes } = require('../../src/store/versions');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { tempDir, removeDir } = require('../helpers/fixtures');

const HEX64 = /^[0-9a-f]{64}$/;
const env = { AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp' };
const config = { paths: { ...PACKAGE_PATHS } };
const policy = { hash: 'c'.repeat(64) };
const pkg = { version: '1.2.3' };

describe('store/versions', () => {
  it('stamps the six versions US3 scenario 4 asks for', () => {
    const versions = collectVersions({ pkg, config, env, policy, deps: { gitSha: 'abc1234' } });
    expect(Object.keys(versions).sort()).to.deep.equal([
      'config_hash', 'git_sha', 'package', 'prompts_hash', 'schema_hash', 'skill_hash',
    ]);
    expect(versions.package).to.equal('1.2.3');
    expect(versions.git_sha).to.equal('abc1234');
    expect(versions.prompts_hash).to.match(HEX64);
    expect(versions.skill_hash).to.match(HEX64);
    expect(versions.schema_hash).to.match(HEX64);
    expect(versions.config_hash).to.equal(policy.hash);
  });

  it('reads the short git sha through the injected exec and returns null when git is unavailable', () => {
    const execFile = sinon.stub().returns(Buffer.from('deadbee\n'));
    expect(resolveGitSha({ execFile, cwd: '/somewhere' })).to.equal('deadbee');
    expect(execFile).to.have.been.calledWith('git', ['rev-parse', '--short', 'HEAD']);
    expect(execFile.firstCall.args[2]).to.include({ cwd: '/somewhere' });
    const failing = sinon.stub().throws(new Error('not a git repository'));
    expect(resolveGitSha({ execFile: failing })).to.equal(null);
  });

  it('uses the injected git sha and definition hashes verbatim when given', () => {
    const deps = {
      gitSha: 'e2e',
      definitionHashes: { prompts_hash: 'p', skill_hash: 's', schema_hash: 'x' },
    };
    const versions = collectVersions({ pkg, config, env, policy, deps });
    expect(versions).to.include({ git_sha: 'e2e', prompts_hash: 'p', skill_hash: 's', schema_hash: 'x' });
  });

  it('falls back to null hashes when a definition directory is missing', () => {
    const broken = { paths: { ...PACKAGE_PATHS, promptsDir: path.join(tempDir(), 'missing') } };
    expect(definitionHashes({ config: broken, env })).to.deep.equal({
      prompts_hash: null, skill_hash: null, schema_hash: null,
    });
    const versions = collectVersions({ pkg, config: broken, env, policy: null, deps: { gitSha: null } });
    expect(versions).to.deep.equal({
      package: '1.2.3', git_sha: null, prompts_hash: null, skill_hash: null, schema_hash: null, config_hash: null,
    });
  });

  it('changes prompts_hash, and only prompts_hash, when one prompt file changes', () => {
    const dir = tempDir();
    try {
      const promptsDir = path.join(dir, 'prompts');
      fs.cpSync(PACKAGE_PATHS.promptsDir, promptsDir, { recursive: true });
      const paths = { ...PACKAGE_PATHS, promptsDir };
      const before = definitionHashes({ config: { paths }, env });
      const original = definitionHashes({ config, env });
      expect(before).to.deep.equal(original);
      fs.appendFileSync(path.join(promptsDir, 'pass-first.md'), '\nLook harder at replication.\n');
      const after = definitionHashes({ config: { paths }, env });
      expect(after.prompts_hash).to.match(HEX64);
      expect(after.prompts_hash).to.not.equal(before.prompts_hash);
      expect(after.skill_hash).to.equal(before.skill_hash);
      expect(after.schema_hash).to.equal(before.schema_hash);
    } finally {
      removeDir(dir);
    }
  });
});
