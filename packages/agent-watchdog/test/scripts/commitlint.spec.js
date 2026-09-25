// The commit convention CI enforces (constitution I): `type(#issue): subject`, the plain `type: subject` the
// founding branch carries from before its issues existed, and since revision 35 the `!` breaking-change marker
// in either form. The release analyzer reads the same headers (revision 36).
const config = require('../../commitlint.config');
const release = require('../../release.config');

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

describe('release.config: the analyzer and the notes read the headers commitlint accepts (revision 36)', () => {
  const plugin = (name) => release.plugins.find((entry) => Array.isArray(entry) && entry[0] === name);

  it('uses the conventionalcommits preset with the CHT header pattern, so `!` marks a breaking change', () => {
    const analyzer = plugin('@semantic-release/commit-analyzer');
    const notes = plugin('@semantic-release/release-notes-generator');
    expect(analyzer[1].preset).to.equal('conventionalcommits');
    expect(notes[1].preset).to.equal('conventionalcommits');
    expect(notes[1].parserOpts).to.equal(analyzer[1].parserOpts);
    const { headerPattern, breakingHeaderPattern } = analyzer[1].parserOpts;
    expect(headerPattern.source).to.equal(config.parserPreset.parserOpts.headerPattern.source);
    expect(breakingHeaderPattern.test('feat(#12)!: change the contract')).to.equal(true);
    expect(breakingHeaderPattern.test('refactor!: drop the old form')).to.equal(true);
    expect(breakingHeaderPattern.test('feat(#12): add the thing')).to.equal(false);
    expect(breakingHeaderPattern.test('fix: repair it')).to.equal(false);
    expect(breakingHeaderPattern.exec('feat(#12)!: change the contract').slice(1))
      .to.deep.equal(['feat', '#12', 'change the contract']);
  });
});
