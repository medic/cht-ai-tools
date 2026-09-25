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

describe('release.config: the analyzer and the notes read the headers commitlint accepts (revision 37)', () => {
  const plugin = (name) => release.plugins.find((entry) => Array.isArray(entry) && entry[0] === name);
  const analyzer = plugin('@semantic-release/commit-analyzer');
  const notes = plugin('@semantic-release/release-notes-generator');
  const logger = { log() {}, error() {}, warn() {}, success() {} };
  const contextWith = (messages) => ({
    cwd: process.cwd(),
    env: {},
    logger,
    commits: messages.map((message, i) => ({ hash: `a1b2c3d${i}`, message, committerDate: '2026-09-25T00:00:00Z' })),
    options: { repositoryUrl: 'https://github.com/medic/cht-ai-tools.git' },
    lastRelease: { gitTag: 'agent-watchdog-v1.0.0', version: '1.0.0', gitHead: 'x' },
    nextRelease: { gitTag: 'agent-watchdog-v1.1.0', version: '1.1.0', gitHead: 'y' },
  });

  it('gives both plugins the CHT header pattern and no preset the installed writer cannot render', () => {
    expect(analyzer[1]).to.not.have.property('preset');
    expect(notes[1]).to.not.have.property('preset');
    expect(notes[1].parserOpts).to.equal(analyzer[1].parserOpts);
    const { headerPattern, breakingHeaderPattern } = analyzer[1].parserOpts;
    expect(headerPattern.source).to.equal(config.parserPreset.parserOpts.headerPattern.source);
    expect(breakingHeaderPattern.test('feat(#12)!: change the contract')).to.equal(true);
    expect(breakingHeaderPattern.test('refactor!: drop the old form')).to.equal(true);
    expect(breakingHeaderPattern.test('feat(#12): add the thing')).to.equal(false);
  });

  it('scores `!` as major and renders the notes offline with the installed plugins', async function release() {
    this.timeout(20000);
    const { analyzeCommits } = await import('@semantic-release/commit-analyzer');
    const { generateNotes } = await import('@semantic-release/release-notes-generator');
    const scored = {};
    for (const message of ['feat: add a thing', 'fix: repair it', 'feat(#12)!: change the contract', 'docs: words']) {
      scored[message] = await analyzeCommits(analyzer[1], contextWith([message]));
    }
    expect(scored).to.deep.equal({
      'feat: add a thing': 'minor', 'fix: repair it': 'patch', 'feat(#12)!: change the contract': 'major',
      'docs: words': null,
    });
    const text = await generateNotes(notes[1], contextWith(['feat: add a thing', 'feat(#12)!: change the contract']));
    expect(text).to.include('### Features');
    expect(text).to.include('add a thing');
    expect(text).to.include('BREAKING CHANGES');
    expect(text).to.include('change the contract');
  });
});
