// semantic-release for one package in the cht-ai-tools monorepo (research.md R-12). The analyzer and the notes
// read the headers commitlint accepts (commitlint.config.js): the conventionalcommits preset understands the `!`
// breaking-change marker, which the default angular preset does not (revision 36).
const parserOpts = {
  headerPattern: /^(\w+)(?:\((#\d+)\))?!?: (.+)$/,
  breakingHeaderPattern: /^(\w+)(?:\((#\d+)\))?!: (.+)$/,
  headerCorrespondence: ['type', 'scope', 'subject'],
};

module.exports = {
  branches: ['main'],
  tagFormat: 'agent-watchdog-v${version}',
  extends: 'semantic-release-monorepo',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits', parserOpts }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits', parserOpts }],
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    ['@semantic-release/exec', {
      publishCmd: [
        'docker build --build-arg VERSION=${nextRelease.version} --build-arg REVISION=${nextRelease.gitHead} '
          + '-t ghcr.io/medic/agent-watchdog:${nextRelease.version} .',
        'docker push ghcr.io/medic/agent-watchdog:${nextRelease.version}',
      ].join(' && '),
    }],
    ['@semantic-release/git', {
      assets: ['CHANGELOG.md', 'package.json'],
      message: 'chore: release agent-watchdog ${nextRelease.version} [skip ci]',
    }],
    '@semantic-release/github',
  ],
};
