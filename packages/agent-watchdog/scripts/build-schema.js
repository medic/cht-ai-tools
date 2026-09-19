#!/usr/bin/env node
'use strict';
// Regenerate schema/*.json from the zod definitions. Run after changing src/agent/output-schema.js.
const fs = require('node:fs');
const path = require('node:path');
const { toJsonSchemas } = require('../src/agent/output-schema');

const dir = path.join(__dirname, '..', 'schema');
fs.mkdirSync(dir, { recursive: true });
const { findings, brief } = toJsonSchemas();
fs.writeFileSync(path.join(dir, 'findings.schema.json'), `${JSON.stringify(findings, null, 2)}\n`);
fs.writeFileSync(path.join(dir, 'brief.schema.json'), `${JSON.stringify(brief, null, 2)}\n`);
console.log('wrote schema/findings.schema.json and schema/brief.schema.json');
