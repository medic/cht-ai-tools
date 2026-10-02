#!/usr/bin/env node
'use strict';
// Secret and personal-data scan (SC-010; constitution IV, Security Requirements). Applies the gate's patterns to the
// repository and, with --runs, to run artefacts. Exit 1 when anything is found; the matched values are never printed.
// Usage: node scripts/scan-secrets.js [path ...] [--runs <data-or-run-dir>]
const path = require('node:path');
const { scanRepository, scanRunArtefacts } = require('../src/verify/scan');

const main = (argv) => {
  const paths = [];
  let runs = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runs') {
      runs = argv[i + 1];
      i += 1;
    } else {
      paths.push(argv[i]);
    }
  }
  if (!paths.length && !runs) {
    paths.push('.');
  }
  const findings = [];
  for (const target of paths) {
    const root = path.resolve(target);
    findings.push(...scanRepository(root).map((f) => ({ scope: 'repository', root, ...f })));
  }
  if (runs) {
    const root = path.resolve(runs);
    findings.push(...scanRunArtefacts(root).map((f) => ({ scope: 'runs', root, ...f })));
  }
  for (const finding of findings) {
    console.log(`${finding.scope} ${finding.file}:${finding.line} ${finding.pattern} ${finding.excerpt}`);
  }
  const scanned = [
    ...paths.map((p) => `repository ${path.resolve(p)}`), ...(runs ? [`runs ${path.resolve(runs)}`] : []),
  ];
  console.log(`${findings.length} finding${findings.length === 1 ? '' : 's'} in ${scanned.join(', ')}`);
  return findings.length ? 1 : 0;
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
