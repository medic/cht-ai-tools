// Flat config wrapping the shared Medic eslintrc-format config, the way cht-core does.
const { FlatCompat } = require('@eslint/eslintrc');
const js = require('@eslint/js');
const globals = require('globals');

const compat = new FlatCompat({ baseDirectory: __dirname, recommendedConfig: js.configs.recommended });

module.exports = [
  {
    ignores: [
      'node_modules/**', 'coverage/**', '.nyc_output/**', '.data/**', 'runs/**', 'runs-replay/**',
      '**/*.json', '**/*.md', '**/*.yaml', '**/*.yml', '**/*.hbs',
    ],
  },
  ...compat.extends('@medic'),
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['test/**/*.js', 'smoke/**/*.js', 'scripts/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha } },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['bin/**/*.js'],
    rules: { 'no-console': 'off' },
  },
];
