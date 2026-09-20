// The replay evaluation is the regression gate for prompt, skill and analysis changes (constitution II,
// Quality Gates): it runs the fixture days offline and compares candidates, gate verdicts, items and the
// labelled feedback set with the committed expectations.
const fs = require('node:fs');
const path = require('node:path');
const { evaluate, analyseCase, compareCandidates, checkLabels } = require('../../scripts/replay-eval');
const { fixturePath, tempDir, removeDir } = require('../helpers/fixtures');
const { quietLogger } = require('../rollup/factories');

const FIXTURES = fixturePath();

const copyFixtures = () => {
  const dir = tempDir();
  fs.cpSync(FIXTURES, dir, { recursive: true });
  return dir;
};

const rewriteJson = (file, mutate) => {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(doc);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
};

describe('scripts/replay-eval', function () {
  this.timeout(60000);

  it('passes on the committed fixtures without touching the network', async () => {
    const report = await evaluate({ log: quietLogger() });
    expect(report.ok, JSON.stringify(report, null, 2)).to.equal(true);
    expect(report.cases.map((c) => c.case).sort()).to.deep.equal(['quiet-day', 'seeded-anomaly']);
    const seeded = report.cases.find((c) => c.case === 'seeded-anomaly');
    expect(seeded.candidates.missing).to.deep.equal([]);
    expect(seeded.candidates.unexpected).to.deep.equal([]);
    expect(seeded.gate.map((g) => g.project).sort()).to.deep.equal(['alpha-example-org', 'gamma-example-org']);
    expect(seeded.gate.every((g) => g.outcome === 'accepted' && g.outcome === g.expected)).to.equal(true);
    expect(seeded.items.actual.map((i) => i.host).sort()).to.deep.equal(['alpha.example.org', 'gamma.example.org']);
    expect(seeded.labels.map((l) => l.satisfied)).to.deep.equal([true, true]);
    const quiet = report.cases.find((c) => c.case === 'quiet-day');
    expect(quiet.candidates.actual).to.equal(0);
    expect(quiet.gate).to.deep.equal([]);
    expect(quiet.items.actual).to.deep.equal([]);
  });

  it('reports an expected candidate that the analysis no longer raises as a regression', async () => {
    const dir = copyFixtures();
    try {
      rewriteJson(path.join(dir, 'runs', 'seeded-anomaly', 'expected.json'), (doc) => {
        doc.candidates.push({
          host: 'beta.example.org', metric_contains: 'cht_conflict_count', rules: ['pct_change'], severity_floor: 'low',
        });
      });
      const report = await evaluate({ fixturesDir: dir, cases: ['seeded-anomaly'], log: quietLogger() });
      expect(report.ok).to.equal(false);
      const seeded = report.cases[0];
      expect(seeded.ok).to.equal(false);
      expect(seeded.candidates.missing).to.have.length(1);
      expect(seeded.candidates.missing[0])
        .to.include({ host: 'beta.example.org', metric_contains: 'cht_conflict_count' });
    } finally {
      removeDir(dir);
    }
  });

  it('reports a label whose verdict the items contradict as a regression', async () => {
    const dir = copyFixtures();
    try {
      rewriteJson(path.join(dir, 'feedback-labels.json'), (doc) => {
        doc.labels.push({
          case: 'seeded-anomaly', host: 'alpha.example.org', metric: 'cht_sentinel_backlog_count', verdict: 'dismissed',
          note: 'tampered: contradicts the recorded item',
        });
      });
      const report = await evaluate({ fixturesDir: dir, cases: ['seeded-anomaly'], log: quietLogger() });
      expect(report.ok).to.equal(false);
      const labels = report.cases[0].labels;
      expect(labels.filter((l) => !l.satisfied)).to.have.length(1);
      expect(labels.find((l) => !l.satisfied).label.verdict).to.equal('dismissed');
    } finally {
      removeDir(dir);
    }
  });

  it('reports a rejected gate or a changed item set as a regression', async () => {
    const dir = copyFixtures();
    try {
      const recorded = path.join(dir, 'runs', 'seeded-anomaly', 'findings', 'alpha-example-org.pass1.json');
      rewriteJson(recorded, (doc) => {
        doc.items[0].why_now = 'The backlog reached 999999 which matches no computed value.';
      });
      const report = await evaluate({ fixturesDir: dir, cases: ['seeded-anomaly'], log: quietLogger() });
      expect(report.ok).to.equal(false);
      const alpha = report.cases[0].gate.find((g) => g.project === 'alpha-example-org');
      expect(alpha.outcome).to.equal('rejected');
      expect(alpha.failing).to.include('numbers_match');
      expect(report.cases[0].items.missing.map((i) => i.host)).to.deep.equal(['alpha.example.org']);
    } finally {
      removeDir(dir);
    }
  });

  it('exposes the case analysis for the fixture recorder', async () => {
    const dataDir = tempDir();
    try {
      const analysed = await analyseCase({
        fixturesDir: FIXTURES, caseName: 'seeded-anomaly', dataDir, logger: quietLogger(),
      });
      expect(analysed.date).to.equal('2026-09-18');
      expect(analysed.projects.map((p) => p.slug)).to.deep.equal([
        'alpha-example-org', 'beta-example-org', 'gamma-example-org',
      ]);
      expect(analysed.projects[0].candidates.length).to.be.greaterThan(0);
      expect(analysed.projects[0].windows.length).to.be.greaterThan(0);
    } finally {
      removeDir(dataDir);
    }
  });

  it('compares candidates by host, metric, rule set and severity floor', () => {
    const actual = [
      { host: 'a', metric: 'cht_x', rule: 'pct_change', severity_floor: 'high' },
      { host: 'a', metric: 'cht_x', rule: 'deviation', severity_floor: 'high' },
    ];
    const ok = compareCandidates({
      expected: [{ host: 'a', metric_contains: 'cht_x', rules: ['deviation', 'pct_change'], severity_floor: 'high' }],
      actual,
    });
    expect(ok.missing).to.deep.equal([]);
    expect(ok.unexpected).to.deep.equal([]);
    expect(ok.mismatched).to.deep.equal([]);
    const wrong = compareCandidates({
      expected: [{ host: 'a', metric_contains: 'cht_x', rules: ['pct_change'], severity_floor: 'low' }],
      actual,
    });
    expect(wrong.mismatched).to.have.length(1);
    expect(wrong.mismatched[0].reasons.join(' ')).to.match(/rules/).and.match(/severity_floor/);
    const extra = compareCandidates({ expected: [], actual });
    expect(extra.unexpected.map((u) => u.metric)).to.deep.equal(['cht_x']);
  });

  it('checks labels against the accepted items of their case', () => {
    const items = [{ host: 'a', metric: 'm', severity: 'high' }];
    const labels = [
      { case: 'c', host: 'a', metric: 'm', verdict: 'confirmed' },
      { case: 'c', host: 'b', metric: 'n', verdict: 'dismissed' },
      { case: 'c', host: 'a', metric: 'm', verdict: 'dismissed' },
      { case: 'other', host: 'z', metric: 'z', verdict: 'confirmed' },
    ];
    const result = checkLabels({ caseName: 'c', labels, items });
    expect(result.map((r) => r.satisfied)).to.deep.equal([true, true, false]);
  });
});
