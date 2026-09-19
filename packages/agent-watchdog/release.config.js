// semantic-release for one package in the cht-ai-tools monorepo (research.md R-12).
module.exports = {
  branches: ['main'],
  tagFormat: 'agent-watchdog-v${version}',
  extends: 'semantic-release-monorepo',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    ['@semantic-release/exec', {
      publishCmd: [
        'docker build -t ghcr.io/medic/agent-watchdog:${nextRelease.version} .',
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
