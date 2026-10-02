'use strict';
// Stage registry and the input-check every stage performs before starting (contracts/run-directory.md).
const fs = require('node:fs');
const path = require('node:path');
const codes = require('../exit-codes');

const STAGE_ORDER = ['purge', 'feedback', 'collect', 'analyze', 'agent', 'rollup', 'render', 'publish'];

const loadStage = (name) => {
  if (!STAGE_ORDER.includes(name)) {
    throw new codes.ExitError(codes.USAGE, `unknown stage "${name}"; expected one of ${STAGE_ORDER.join(', ')}`);
  }
  const file = path.join(__dirname, `${name}.js`);
  if (!fs.existsSync(file)) {
    throw new codes.ExitError(codes.USAGE, `stage "${name}" is not implemented in this build`);
  }
  return require(file);
};

/** Refuse to start when a required input is missing (exit 65); never fabricate inputs. */
const requireInputs = (runDir, relPaths) => {
  const missing = relPaths.filter((rel) => !runDir.exists(rel));
  if (missing.length) {
    const noun = missing.length === 1 ? 'input' : 'inputs';
    throw new codes.ExitError(codes.DATAERR, `missing stage ${noun}: ${missing.join(', ')}`, { missing });
  }
};

module.exports = { STAGE_ORDER, loadStage, requireInputs };
