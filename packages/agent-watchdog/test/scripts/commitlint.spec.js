// The commit convention CI enforces (constitution I): `type(#issue): subject`, `type: subject`, and since
// revision 35 the `!` breaking-change marker in either form.
const config = require('../../commitlint.config');

describe('commitlint.config', () => {
  const pattern = config.parserPreset.parserOpts.headerPattern;
  const parse = (header) => {
    const match = pattern.exec(header);
    return match ? { type: match[1], scope: match[2] || null, subject: match[3] } : null;
  };

  it('parses the CHT header forms, with and without an issue and with the breaking-change marker', () => {
    expect(parse('feat(#12): add the thing')).to.deep.equal({ type: 'feat', scope: '#12', subject: 'add the thing' });
    expect(parse('fix: repair it')).to.deep.equal({ type: 'fix', scope: null, subject: 'repair it' });
    expect(parse('feat(#12)!: change the contract')).to.deep.equal({
      type: 'feat', scope: '#12', subject: 'change the contract',
    });
    expect(parse('refactor!: drop the old form')).to.deep.equal({
      type: 'refactor', scope: null, subject: 'drop the old form',
    });
  });

  it('refuses a free-text scope, a missing space and a bare subject', () => {
    expect(parse('feat(api): x')).to.equal(null);
    expect(parse('feat:x')).to.equal(null);
    expect(parse('just words')).to.equal(null);
    expect(config.rules['header-max-length']).to.deep.equal([2, 'always', 100]);
  });
});
