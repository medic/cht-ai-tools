// Fixture loading and temporary directories for tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

const fixturePath = (...parts) => path.join(FIXTURES, ...parts);

const loadJson = (...parts) => JSON.parse(fs.readFileSync(fixturePath(...parts), 'utf8'));

const loadText = (...parts) => fs.readFileSync(fixturePath(...parts), 'utf8');

const tempDir = (prefix = 'agent-watchdog-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// A fake clock: returns a Date for the run start and an ISO string.
const RUN_START = new Date('2026-09-18T06:00:00Z');

module.exports = { FIXTURES, fixturePath, loadJson, loadText, tempDir, removeDir, RUN_START };
