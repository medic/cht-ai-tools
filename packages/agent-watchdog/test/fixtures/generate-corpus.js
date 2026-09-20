#!/usr/bin/env node
'use strict';
// Writes the two synthetic corpus fixtures that are not hand-written: a 16-byte PNG header (a binary item, not
// a real image) and a repeated-lines dump of about 6 KiB that tests treat as too large by passing
// `maxBytes: 4096`. Re-run `node test/fixtures/generate-corpus.js` after changing this file; the output is committed.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, 'corpus');
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];
const DUMP_LINES = 130;

const main = () => {
  fs.mkdirSync(path.join(ROOT, 'binary'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'too-large'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'binary', 'dashboard.png'), Buffer.from(PNG_HEADER));
  const lines = [];
  for (let i = 0; i < DUMP_LINES; i += 1) {
    const minute = String(i % 60).padStart(2, '0');
    const hour = String(Math.floor(i / 60)).padStart(2, '0');
    lines.push(`2026-05-14T${hour}:${minute}:00Z cht_sentinel_backlog_count 300`);
  }
  fs.writeFileSync(path.join(ROOT, 'too-large', 'metrics-dump.txt'), `${lines.join('\n')}\n`);
  console.log(`wrote ${path.relative(process.cwd(), ROOT)}/binary/dashboard.png and too-large/metrics-dump.txt`);
};

if (require.main === module) {
  main();
}

module.exports = { main, PNG_HEADER, DUMP_LINES };
