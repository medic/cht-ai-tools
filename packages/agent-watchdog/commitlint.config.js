// Conventional Commits in the CHT form `type(#issue): subject`, with plain `type: subject` allowed
// when no issue exists (constitution I).
module.exports = {
  extends: ['@commitlint/config-conventional'],
  parserPreset: {
    parserOpts: {
      headerPattern: /^(\w+)(?:\((#\d+)\))?: (.+)$/,
      headerCorrespondence: ['type', 'scope', 'subject'],
    },
  },
  rules: {
    'type-enum': [2, 'always', ['build', 'feat', 'fix', 'perf', 'refactor', 'test', 'chore', 'docs']],
    'scope-case': [0],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
};
