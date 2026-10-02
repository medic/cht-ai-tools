// Conventional Commits in the CHT form `type(#issue): subject` (constitution I). The scope is optional in the
// pattern because the founding branch was written before any issue existed; work after it references its issue.
// The `!` breaking-change marker is accepted in either form (revision 35).
module.exports = {
  extends: ['@commitlint/config-conventional'],
  parserPreset: {
    parserOpts: {
      headerPattern: /^(\w+)(?:\((#\d+)\))?!?: (.+)$/,
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
