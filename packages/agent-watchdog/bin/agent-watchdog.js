#!/usr/bin/env node
'use strict';
const { main } = require('../src/cli/index');

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error) => {
  process.stderr.write(`${JSON.stringify({ event: 'run.exit', code: 1, reason: error && error.message })}\n`);
  process.exitCode = 1;
});
