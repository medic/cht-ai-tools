const { buildAllowlist, isAllowed, allowedHosts } = require('../../src/links/allowlist');
const { config } = require('../verify/helpers/context');

describe('links/allowlist', () => {
  const allowlist = buildAllowlist(config);

  it('contains the configured hosts, the CHT documentation and forum hosts, and github under /medic/', () => {
    expect(allowedHosts(allowlist)).to.include.members([
      'watchdog.example.org', 'docs.communityhealthtoolkit.org', 'forum.communityhealthtoolkit.org', 'github.com',
      'langfuse.example.org', 'docs-mcp.example.org',
    ]);
  });

  it('allows https links on listed hosts and github only under /medic/', () => {
    expect(isAllowed('https://docs.communityhealthtoolkit.org/hosting/monitoring/', allowlist)).to.equal(true);
    expect(isAllowed('https://github.com/medic/cht-core/issues/1', allowlist)).to.equal(true);
    expect(isAllowed('https://github.com/evil/repo', allowlist)).to.equal(false);
    expect(isAllowed('https://watchdog.example.org/d/abc/x', allowlist)).to.equal(true);
    expect(isAllowed('https://example.com/', allowlist)).to.equal(false);
  });

  it('rejects non-https schemes and unparsable strings', () => {
    expect(isAllowed('http://docs.communityhealthtoolkit.org/', allowlist)).to.equal(false);
    expect(isAllowed('javascript:alert(1)', allowlist)).to.equal(false);
    expect(isAllowed('not a url', allowlist)).to.equal(false);
  });
});
