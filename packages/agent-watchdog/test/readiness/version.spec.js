const { parseVersion, compareVersions, atLeast } = require('../../src/readiness/version');

describe('readiness/version', () => {
  it('parses major.minor.patch with an optional pre-release tag', () => {
    expect(parseVersion('4.11.0')).to.deep.equal({ major: 4, minor: 11, patch: 0, pre: null });
    expect(parseVersion('4.11.0-beta.2')).to.deep.equal({ major: 4, minor: 11, patch: 0, pre: 'beta.2' });
    expect(parseVersion('v3.12.0')).to.deep.equal({ major: 3, minor: 12, patch: 0, pre: null });
    expect(parseVersion('3.17')).to.deep.equal({ major: 3, minor: 17, patch: 0, pre: null });
  });

  it('returns null for anything that is not a version', () => {
    for (const bad of [undefined, null, '', 'latest', '4.x.0', 42, {}]) {
      expect(parseVersion(bad), String(bad)).to.equal(null);
    }
  });

  it('compares on major, minor and patch only, ignoring the pre-release tag', () => {
    expect(compareVersions('3.12.0', '4.0.0')).to.equal(-1);
    expect(compareVersions('4.11.0', '4.3.0')).to.equal(1);
    expect(compareVersions('4.3.0', '4.3.0-beta.1')).to.equal(0);
    expect(compareVersions('4.10.2', '4.9.9')).to.equal(1);
  });

  it('answers atLeast against a minimum and treats an unparseable version as below it', () => {
    expect(atLeast('3.12.0', '3.12.0')).to.equal(true);
    expect(atLeast('3.11.9', '3.12.0')).to.equal(false);
    expect(atLeast('5.0.0-rc.1', '4.11.0')).to.equal(true);
    expect(atLeast('unknown', '3.12.0')).to.equal(false);
  });
});
