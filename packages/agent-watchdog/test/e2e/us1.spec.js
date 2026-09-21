// End-to-end User Story 1 on the synthetic fixtures: real stages, a fake Grafana, a scripted model,
// a stubbed Slack client and a fake browser. Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const runCommand = require('../../src/cli/commands/run');
const codes = require('../../src/cli/exit-codes');
const { createLogger } = require('../../src/log/logger');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath, tempDir, removeDir } = require('../helpers/fixtures');
const { DATE, capture, envFor, fakeTracer, createScriptedEngine, runCase } = require('./helpers');

describe('e2e: User Story 1, the daily brief', function () {
  this.timeout(30000);
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => {
    if (process.env.E2E_KEEP) {
      console.log(`E2E_KEEP: run directory kept at ${dataDir}`);
      return;
    }
    removeDir(dataDir);
  });

  it('flags the seeded sentinel climb and the down scrape target, posts a brief with threaded replies', async () => {
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.code).to.equal(0);
    const run = r.read('run.json');
    expect(run.status).to.equal('published');

    const alpha = r.read('alpha-example-org/candidates.json');
    const sentinel = alpha.filter((c) => c.metric.startsWith('cht_sentinel_backlog_count'));
    expect(sentinel.map((c) => c.rule).sort()).to.deep.equal(['deviation', 'monotonic', 'pct_change']);
    expect(sentinel.every((c) => c.severity_floor === 'high')).to.equal(true);
    const gamma = r.read('gamma-example-org/candidates.json');
    expect(gamma.some((c) => c.rule === 'target_down' && c.severity_floor === 'high')).to.equal(true);

    const brief = r.read('rollup/brief.json');
    expect(brief.kind).to.equal('brief');
    expect(brief.bullets.length).to.be.within(1, 3);
    const alphaBullet = brief.bullets.find((b) => b.text.includes('alpha.example.org'));
    expect(alphaBullet.text).to.include('912');
    expect(alphaBullet.text).to.match(/yesterday/);

    const ranked = r.read('rollup/items.ranked.json');
    const alphaItem = ranked.find((i) => i.project_url === 'https://alpha.example.org');
    expect(alphaItem.severity).to.equal('high');
    expect(alphaItem.evidence.map((e) => e.window)).to.include.members(['current', 'previous_day']);
    expect(alphaItem.dashboard_ref).to.include({ dashboard_uid: 'oa2OfL-Vk', panel_id: 3 });

    const payload = r.read('rollup/payload.json');
    expect(payload.parent.metadata.event_type).to.equal('agent_watchdog.brief');
    // Replies for the body items only; every item is in the report shared into the thread (FR-020, revision 23).
    const layout = r.read('rollup/layout.json');
    expect(payload.replies.map((reply) => reply.item_id).sort()).to.deep.equal([...layout.body_items].sort());
    expect(payload.report)
      .to.include({ path: 'rollup/report.html', items: ranked.length, replied: payload.replies.length });
    const publication = r.read('rollup/publication.json');
    expect(publication.ts).to.be.a('string');
    expect(publication.report).to.include({ file_id: 'F0001' });
    expect(r.slack.files.uploadV2).to.have.been.calledTwice;
    expect(r.slack.files.uploadV2.firstCall.args[0]).to.not.have.property('channel_id');
    expect(r.slack.files.uploadV2.secondCall.args[0]).to.include({ channel_id: 'C123', thread_ts: publication.ts });
    expect(r.slack.chat.postMessage.callCount).to.equal(1 + payload.replies.length);
    const parentCall = r.slack.chat.postMessage.firstCall.args[0];
    const imageBlock = parentCall.blocks.find((b) => b.type === 'image');
    expect(imageBlock && imageBlock.slack_file && imageBlock.slack_file.id).to.equal('F0001');
    for (const call of r.slack.chat.postMessage.getCalls().slice(1)) {
      expect(call.args[0].thread_ts).to.equal(publication.ts);
    }
    expect(fs.existsSync(path.join(r.root, 'rollup', 'report.html'))).to.equal(true);
    expect(fs.existsSync(path.join(r.root, 'rollup', 'brief.png'))).to.equal(true);
    const report = fs.readFileSync(path.join(r.root, 'rollup', 'report.html'), 'utf8');
    expect(report).to.include('id="brief-summary"');
    expect(report).to.not.include('<script');
  });

  it('posts a one-line heartbeat on a quiet day without calling the model', async () => {
    const r = await runCase({ caseName: 'quiet-day', dataDir });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('heartbeat');
    const brief = r.read('rollup/brief.json');
    expect(brief.kind).to.equal('heartbeat');
    expect(brief.bullets).to.have.length(0);
    expect(brief.headline).to.match(/3 projects/);
    expect(r.engine.calls.sessions).to.have.length(0);
    expect(r.engine.calls.singleTurns).to.have.length(0);
    expect(r.slack.chat.postMessage).to.have.been.calledOnce;
    expect(r.slack.files.uploadV2).to.not.have.been.called;
    for (const slug of ['alpha-example-org', 'beta-example-org', 'gamma-example-org']) {
      expect(r.read(`${slug}/candidates.json`)).to.deep.equal([]);
    }
  });

  it('previews the exact payload without posting anything', async () => {
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir, flags: { 'dry-run': true } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('previewed');
    expect(r.slack.chat.postMessage).to.not.have.been.called;
    expect(r.slack.files.uploadV2).to.not.have.been.called;
    const payload = JSON.parse(r.out.text());
    expect(payload).to.deep.equal(r.read('rollup/payload.json'));
    expect(payload.image.slack_file_id).to.equal(null);
    expect(fs.existsSync(path.join(r.root, 'rollup', 'publication.json'))).to.equal(false);
  });

  it('degrades to the deterministic brief after three rejected drafts and still posts with a notice', async () => {
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir, briefMode: 'bad' });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('degraded');
    const brief = r.read('rollup/brief.json');
    expect(brief.kind).to.equal('degraded');
    expect(brief.degradation_notice).to.be.a('string').and.not.empty;
    expect(r.engine.calls.singleTurns).to.have.length(3);
    for (const n of [1, 2, 3]) {
      const report = r.read(`rollup/verification.draft${n}.json`);
      expect(report.outcome).to.equal('rejected');
      expect(report.checks.find((c) => c.name === 'numbers_match').status).to.equal('fail');
    }
    expect(r.slack.chat.postMessage).to.have.been.called;
  });

  it('records two passes with reasons and stops early once a pass changes nothing', async () => {
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir, envExtra: { AGENT_WATCHDOG_PASSES: '3' } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    const passes = r.read('alpha-example-org/passes.json');
    expect(passes.passes).to.have.length(2);
    expect(passes.converged).to.equal(true);
    expect(fs.existsSync(path.join(r.root, 'alpha-example-org', 'findings.pass1.json'))).to.equal(true);
    expect(fs.existsSync(path.join(r.root, 'alpha-example-org', 'findings.pass2.json'))).to.equal(true);
    expect(fs.existsSync(path.join(r.root, 'alpha-example-org', 'findings.pass3.json'))).to.equal(false);
    const session = r.read('alpha-example-org/session.json');
    expect(session.calls).to.have.length(2);
    expect(session.reference_sources_unavailable).to.equal(false);
    // beta had no candidates and must not have opened a session (FR-013)
    expect(fs.existsSync(path.join(r.root, 'beta-example-org', 'session.json'))).to.equal(false);
  });

  it('exits 69 with a failure notice when Grafana is unreachable', async () => {
    const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'quiet-day') });
    const failingFetch = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const out = capture();
    const err = capture();
    const slackPublisher = { postFailureNotice: sinon.stub().resolves({ ts: '1.1' }) };
    let error;
    try {
      await runCommand({
        command: 'run',
        flags: { date: DATE },
        positionals: [],
        env: envFor(dataDir),
        stdout: out.stream,
        stderr: err.stream,
        logger: createLogger({ stream: err.stream, level: 'error' }),
        deps: {
          fetch: failingFetch,
          slackPublisher,
          engine: createScriptedEngine({ dataDir }),
          tracer: fakeTracer(),
          gitSha: 'e2e',
        },
      });
    } catch (e) {
      error = e;
    }
    expect(error.code).to.equal(codes.UNAVAILABLE);
    expect(slackPublisher.postFailureNotice).to.have.been.calledOnce;
    expect(fake.calls).to.have.length(0);
  });
});
