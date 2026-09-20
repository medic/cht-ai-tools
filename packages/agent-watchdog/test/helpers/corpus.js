'use strict';
// Copies the corpus fixtures (item directories only, not the README) into a temporary raw directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixturePath } = require('./fixtures');

const ITEM_DIRS = ['conversations', 'exports', 'incidents', 'explainers', 'binary', 'too-large'];

const copyCorpus = (dest, dirs = ITEM_DIRS) => {
  const copied = [];
  for (const dir of dirs) {
    const source = fixturePath('corpus', dir);
    for (const name of fs.readdirSync(source)) {
      fs.mkdirSync(path.join(dest, dir), { recursive: true });
      fs.copyFileSync(path.join(source, name), path.join(dest, dir, name));
      copied.push(`${dir}/${name}`);
    }
  }
  return copied.sort();
};

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const CONVERSATION = 'conversations/2026-05-14-sentinel-stall.md';
const EXPORT = 'exports/2026-05-14-sentinel-backlog.csv';
const INCIDENT = 'incidents/2026-06-02-outbound-push.md';
const EXPLAINER = 'explainers/sentinel.md';
const BINARY = 'binary/dashboard.png';
const TOO_LARGE = 'too-large/metrics-dump.txt';

module.exports = { copyCorpus, sha256, ITEM_DIRS, CONVERSATION, EXPORT, INCIDENT, EXPLAINER, BINARY, TOO_LARGE };
