#!/usr/bin/env node
'use strict';
// Records the model findings the replay evaluation replays: runs each fixture day through collect and analyze,
// then writes the scripted model's raw findings (test/helpers/scripted-findings.js) to
// test/fixtures/runs/<case>/findings/<slug>.pass1.json. Re-run `node test/fixtures/record-findings.js` after
// changing generate.js; the output is committed. Prints the items the recordings yield, for expected.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyseCase, listCases, FIXTURES_DIR } = require('../../scripts/replay-eval');
const { projectsWithCandidates, findingsFor } = require('../helpers/scripted-findings');
const { createLogger } = require('../../src/log/logger');

const main = async () => {
  const logger = createLogger({ level: 'warn', stream: process.stderr });
  for (const caseName of listCases(FIXTURES_DIR)) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-watchdog-record-'));
    try {
      const analysed = await analyseCase({ caseName, dataDir, logger });
      const outDir = path.join(FIXTURES_DIR, 'runs', caseName, 'findings');
      fs.rmSync(outDir, { recursive: true, force: true });
      const projects = projectsWithCandidates(analysed.runDir.root).filter((p) => p.candidates.length);
      if (!projects.length) {
        console.log(`${caseName}: no candidates, no recordings`);
        continue;
      }
      fs.mkdirSync(outDir, { recursive: true });
      for (const project of projects) {
        const findings = await findingsFor(project, 1);
        const file = path.join(outDir, `${project.slug}.pass1.json`);
        fs.writeFileSync(file, `${JSON.stringify(findings, null, 2)}\n`);
        for (const item of findings.items) {
          console.log(`${caseName}: ${project.slug} ${item.item_key.metric} ${item.severity}`);
        }
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
