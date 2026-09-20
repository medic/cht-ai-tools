// SC-010: the gate's secret and personal-data patterns applied to files, and the repository itself clean.
const fs = require('node:fs');
const path = require('node:path');
const { scanText, scanTree, scanRepository, scanRunArtefacts, MIN_SECRET_LENGTH } = require('../../src/verify/scan');
const { main } = require('../../scripts/scan-secrets');
const { tempDir, removeDir } = require('../helpers/fixtures');

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const SLACK = `xoxb-${'1234567890'.repeat(5)}`;
const ANTHROPIC = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
const GRAFANA = `glsa_${'x9Y8z7W6'.repeat(4)}`;

describe('verify/scan', () => {
  it('finds credential-shaped tokens and skips the placeholders the tests use', () => {
    const text = `token ${SLACK}\nkey ${ANTHROPIC}\nglsa ${GRAFANA}\nAuthorization: Bearer ${'abcdefgh'.repeat(4)}`;
    expect(scanText(text).map((f) => `${f.line}:${f.pattern}`)).to.deep.equal([
      '1:slack_token', '2:anthropic_key', '3:grafana_token', '4:bearer',
    ]);
    expect(scanText(text).every((f) => !f.excerpt.includes(SLACK.slice(10)))).to.equal(true);
    expect(scanText('SLACK_BOT_TOKEN=xoxb-test ANTHROPIC_API_KEY=sk-ant-test glsa_test')).to.deep.equal([]);
    expect(scanText(`xoxb-${'a'.repeat(MIN_SECRET_LENGTH)}-fake`)).to.deep.equal([]);
    expect(scanText(`xoxb-${'a'.repeat(MIN_SECRET_LENGTH)}`)).to.have.length(1);
  });

  it('finds e-mail addresses outside example domains, and phone numbers only when asked', () => {
    expect(scanText('write to someone@medic.org').map((f) => f.pattern)).to.deep.equal(['email']); // scan-secrets:allow
    expect(scanText('sample someone@medic.org // scan-secrets:allow')).to.deep.equal([]);
    expect(scanText('ops@cht.example.org and noreply@example.com')).to.deep.equal([]);
    const phone = 'call +254 712 345 678 tomorrow';
    expect(scanText(phone)).to.deep.equal([]);
    expect(scanText(phone, { phones: true }).map((f) => f.pattern)).to.deep.equal(['phone']);
    // Identifiers and Slack timestamps are not phone numbers.
    expect(scanText('ts 1758088800.000100 id a1b2c3d4e5f6 hex 0123456789abcdef', { phones: true })).to.deep.equal([]);
    expect(scanText('2026-09-18T06:00:00Z 20260918060000', { phones: true })).to.deep.equal([]);
    // A CHT version string carries long digit runs with separators; it sits in a token with letters.
    const version = '"cht_version": "5.2.0-10700-photo-capture.29102352761-1783696221314",';
    expect(scanText(version, { phones: true })).to.deep.equal([]);
    expect(scanText('call 0712-345-678 now', { phones: true }).map((f) => f.pattern)).to.deep.equal(['phone']);
  });

  describe('scanning trees', () => {
    let dir;
    beforeEach(() => {
      dir = tempDir();
      fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'runs', 'r1'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), `const t = '${SLACK}';\n`);
      fs.writeFileSync(path.join(dir, 'ok.js'), 'const token = "xoxb-test";\n');
      const lockFile = JSON.stringify({ author: 'someone@medic.org' }); // scan-secrets:allow
      fs.writeFileSync(path.join(dir, 'package-lock.json'), lockFile);
      fs.writeFileSync(path.join(dir, 'leak.md'), `line one\nkey ${ANTHROPIC}\n`);
      fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
      fs.writeFileSync(path.join(dir, 'binary.dat'), Buffer.from([0, 1, 2, 3, 0, 5]));
      const ingested = JSON.stringify({ note: 'ring +254 712 345 678', author: 'U1' });
      fs.writeFileSync(path.join(dir, 'runs', 'r1', 'feedback.ingested.json'), ingested);
    });
    afterEach(() => removeDir(dir));

    it('skips dependencies, lock files, run data and binary files when scanning a repository', () => {
      const findings = scanRepository(dir);
      expect(findings.map((f) => [f.file, f.line, f.pattern])).to.deep.equal([['leak.md', 2, 'anthropic_key']]);
      expect(findings[0].excerpt).to.match(/^sk-ant…\(\d+ chars\)$/);
    });

    it('scans run artefacts with phone numbers included', () => {
      const findings = scanRunArtefacts(path.join(dir, 'runs'));
      expect(findings.map((f) => [f.file, f.pattern])).to.deep.equal([['r1/feedback.ingested.json', 'phone']]);
      expect(scanTree(dir, { phones: true, skipDirs: new Set(['node_modules']) }).map((f) => f.pattern).sort())
        .to.deep.equal(['anthropic_key', 'phone']);
    });

    it('exits 1 from the command line when anything is found and 0 when the tree is clean', () => {
      const log = sinon.stub(console, 'log');
      try {
        expect(main([dir])).to.equal(1);
        expect(log.getCalls().some((c) => /leak\.md:2 anthropic_key/.test(c.args[0]))).to.equal(true);
        expect(log.lastCall.args[0]).to.match(/^1 finding in repository/);
        expect(main(['--runs', path.join(dir, 'runs')])).to.equal(1);
        fs.rmSync(path.join(dir, 'leak.md'));
        expect(main([dir])).to.equal(0);
      } finally {
        log.restore();
      }
    });
  });

  it('finds nothing in this package (SC-010)', function () {
    this.timeout(20000);
    const findings = scanRepository(PACKAGE_ROOT);
    expect(findings, JSON.stringify(findings, null, 2)).to.deep.equal([]);
  });
});
