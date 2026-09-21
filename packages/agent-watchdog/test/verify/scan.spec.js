'use strict';
// FR-016 (revision 19): a date is not a phone number, and a finding in a recorded tool result is reference text the
// model was given, not output the run wrote, so the two are counted apart.
const fs = require('node:fs');
const path = require('node:path');
const { scanRunArtefacts, REFERENCE_FILES, isReferenceFile } = require('../../src/verify/scan');
const { tempDir, removeDir } = require('../helpers/fixtures');

describe('verify/scan run artefacts', () => {
  let root;
  beforeEach(() => {
    root = tempDir();
    fs.mkdirSync(path.join(root, 'alpha-example-org'), { recursive: true });
  });
  afterEach(() => removeDir(root));

  const write = (rel, text) => fs.writeFileSync(path.join(root, rel), text);

  it('does not report a date or a date and time as a phone number', () => {
    // Both forms were reported against fetched CHT documentation in run 2026-09-20.
    write('rollup-notes.md', 'release notes dated 2024-07-16 15:04 and 2025-08-20 13:22, window 2026-09-18');
    expect(scanRunArtefacts(root)).to.deep.equal([]);
  });

  it('counts a finding in a recorded tool result as reference text, not as the run\'s own output', () => {
    const doc = JSON.stringify({
      tool_name: 'mcp__cht-docs__search_docs',
      tool_response: 'write to hello@medic.org, see build 1755695714630', // scan-secrets:allow
    });
    write(path.join('alpha-example-org', 'tool-calls.jsonl'), `${doc}\n`);
    const findings = scanRunArtefacts(root);
    expect(findings.length).to.be.greaterThan(0);
    expect(findings.every((f) => f.reference === true)).to.equal(true);
    const calls = 'alpha-example-org/tool-calls.jsonl';
    expect(findings.map((f) => f.file)).to.deep.equal(Array(findings.length).fill(calls));
    // The matched value is still never included, reference text or not.
    expect(JSON.stringify(findings)).to.not.include('hello@medic.org'); // scan-secrets:allow
  });

  it('marks a finding anywhere else as the run\'s own output', () => {
    const prose = '{"why_now":"ask hello@medic.org"}'; // scan-secrets:allow
    write(path.join('alpha-example-org', 'findings.pass1.json'), prose);
    const findings = scanRunArtefacts(root);
    expect(findings).to.have.length(1);
    expect(findings[0].reference).to.equal(false);
    expect(findings[0].pattern).to.equal('email');
  });

  it('names the files whose findings are reference text, and answers for a path', () => {
    expect([...REFERENCE_FILES]).to.deep.equal(['tool-calls.jsonl']);
    expect(isReferenceFile('alpha-example-org/tool-calls.jsonl')).to.equal(true);
    expect(isReferenceFile('tool-calls.jsonl')).to.equal(true);
    expect(isReferenceFile('alpha-example-org/findings.pass1.json')).to.equal(false);
    expect(isReferenceFile('rollup/payload.json')).to.equal(false);
  });
});
