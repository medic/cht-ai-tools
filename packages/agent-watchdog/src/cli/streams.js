'use strict';
// stdout carries results only; logs go to stderr (contracts/cli.md).
const writeResult = (stream, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
};

module.exports = { writeResult };
