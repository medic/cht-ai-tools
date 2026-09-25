// semantic-release for one package in the cht-ai-tools monorepo (research.md R-12). The analyzer and the notes
// keep their default preset and read the headers commitlint accepts through these parser options: the
// breakingHeaderPattern turns a `!` header into a breaking-change note, which the analyzer scores as a major
// release and the notes list (revision 37). The conventionalcommits preset tried in revision 36 needs a newer
// changelog writer than the plugins ship, and threw on every release.
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
    ['@semantic-release/commit-analyzer', { parserOpts }],
    ['@semantic-release/release-notes-generator', { parserOpts }],
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
