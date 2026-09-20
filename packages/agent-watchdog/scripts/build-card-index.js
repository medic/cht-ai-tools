#!/usr/bin/env node
'use strict';
// Regenerate skill/cht-watchdog/pattern-cards/index.md from the merged cards (FR-038): the daily analysis loads
// this one-line-per-card index, never the cards themselves. Run after merging a card; `--check` fails when the
// committed index is stale, for CI on card pull requests.
// Usage: node scripts/build-card-index.js [--skill-dir <dir>] [--check]
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadPatternCards, buildIndex } = require('../src/corpus/cards');
const { PACKAGE_PATHS } = require('../src/config/schema');
const { writeFileAtomic } = require('../src/store/atomic');

/**
 * @param {object} [options]
 * @param {string} [options.skillDir] skill directory holding pattern-cards/
 * @param {boolean} [options.check] compare only; never write
 * @returns {Promise<{ code: number, changed: boolean, written: boolean, file: string, merged: string[] }>}
 */
const buildCardIndex = async ({ skillDir = PACKAGE_PATHS.skillDir, check = false } = {}) => {
  const cards = loadPatternCards({ skillDir });
  const file = path.join(skillDir, 'pattern-cards', 'index.md');
  const generated = buildIndex(cards.all);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const changed = current !== generated;
  if (check) {
    return { code: changed ? 1 : 0, changed, written: false, file, merged: cards.index };
  }
  if (changed) {
    await writeFileAtomic(file, generated);
  }
  return { code: 0, changed, written: changed, file, merged: cards.index };
};

const main = async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { 'skill-dir': { type: 'string' }, check: { type: 'boolean' } },
    strict: true,
  });
  const skillDir = values['skill-dir'] ? path.resolve(values['skill-dir']) : PACKAGE_PATHS.skillDir;
  const result = await buildCardIndex({ skillDir, check: Boolean(values.check) });
  const cards = result.merged.length === 1 ? '1 merged card' : `${result.merged.length} merged cards`;
  if (values.check) {
    const verdict = result.changed ? `is stale (${cards}); run npm run cards:index` : `is current (${cards})`;
    console.log(`${result.file} ${verdict}`);
  } else {
    console.log(result.written ? `wrote ${result.file} (${cards})` : `${result.file} unchanged (${cards})`);
  }
  process.exitCode = result.code;
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildCardIndex };
