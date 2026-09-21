const { verifyFindings, verifyBrief, CHECK_NAMES } = require('../../src/verify/gate');
const { schemas } = require('../../src/model/schemas');
const { itemId } = require('../../src/model/identity');
const { baseContext, briefContext, URL, METRIC } = require('./helpers/context');

const args = (ctx, extra = {}) => ({
  findings: ctx.findings,
  pass: 1,
  project: ctx.project,
  discovery: ctx.discovery,
  changes: ctx.changes,
  candidates: ctx.candidates,
  windows: ctx.windows,
  toolResultUrls: ctx.toolResultUrls,
  knownCards: ctx.knownCards,
  allowlist: ctx.allowlist,
  attempt: 1,
  ...extra,
});

describe('verify/gate', () => {
  it('exposes the fixed check list in order', () => {
    expect(CHECK_NAMES).to.deep.equal([
      'schema', 'projects_known', 'metrics_known', 'candidates_known', 'numbers_match', 'dates_match', 'links_built',
      'links_allowlisted', 'links_resolve', 'severity_rules', 'bullet_count', 'bullet_length', 'secrets_absent',
      'personal_data_absent', 'pattern_cards_known',
    ]);
  });

  it('builds each item\'s dashboard reference from the run\'s windows, never from the model (revision 18)',
    async () => {
      const ctx = baseContext();
      // The model sends no dashboard reference at all; the run's own windows supply every part of it.
      expect(ctx.findings.items[0]).to.not.have.property('dashboard_ref');
      const { report, items } = await verifyFindings(args(ctx));
      const current = ctx.windows.find((w) => w.window === 'current');
      expect(items[0].dashboard_ref).to.deep.equal({
        dashboard_uid: current.panel_ref.dashboard_uid,
        panel_id: current.panel_ref.panel_id,
        project_url: URL,
        from: current.start,
        to: current.end,
      });
      expect(report.checks.find((c) => c.name === 'dates_match').status).to.equal('pass');
      expect(report.outcome).to.equal('accepted');

      // A model that sends one anyway is rejected by the schema rather than quietly obeyed.
      const stray = baseContext();
      stray.findings.items[0].dashboard_ref = {
        dashboard_uid: 'made-up', panel_id: 999, from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z',
      };
      const strayReport = (await verifyFindings(args(stray))).report;
      expect(strayReport.outcome).to.equal('rejected');
      expect(strayReport.checks.find((c) => c.name === 'schema').reasons.join(' ')).to.include('dashboard_ref');
    });

  it('rejects an item whose metric has no collected window, naming the item', async () => {
    const ctx = baseContext();
    const { report } = await verifyFindings(args(ctx, { windows: [] }));
    expect(report.outcome).to.equal('rejected');
    const reasons = report.checks.flatMap((c) => (c.status === 'fail' ? c.reasons : []));
    expect(reasons.some((r) => /items\[0\].*no collected window/.test(r))).to.equal(true);
  });

  it('accepts a valid findings document and returns normalised items with code-derived identity', async () => {
    const ctx = baseContext();
    const { report, items } = await verifyFindings(args(ctx));
    expect(report.outcome).to.equal('accepted');
    expect(report.subject).to.equal('pass');
    expect(report.subject_ref).to.equal('cht-example-org/pass1');
    expect(report.attempt).to.equal(1);
    expect(report.checks.map((c) => c.name)).to.deep.equal(CHECK_NAMES);
    expect(schemas.VerificationReport.parse(report)).to.be.an('object');
    expect(items).to.have.length(1);
    expect(items[0].item_id).to.equal(itemId(URL, METRIC, null));
    expect(items[0]).to.include({ project_url: URL, metric: METRIC, persisting_days: 1, rank: null, placement: null });
    expect(items[0].dashboard_ref.project_url).to.equal(URL);
    expect(schemas.Item.parse(items[0])).to.be.an('object');
  });

  it('rejects high severity without a high candidate, keeping the severity as written', async () => {
    const ctx = baseContext();
    ctx.findings.items[0].candidate_ids = ['0123456789ab'];
    const { report, items } = await verifyFindings(args(ctx));
    expect(report.outcome).to.equal('rejected');
    expect(report.checks.find((c) => c.name === 'severity_rules').status).to.equal('fail');
    expect(items[0].severity).to.equal('high');
  });

  it('rejects a number that matches no evidence and an unknown candidate id', async () => {
    const ctx = baseContext();
    ctx.findings.items[0].why_now = 'Backlog is 999.';
    ctx.findings.items[0].candidate_ids = ['0123456789ab', 'deadbeefdead'];
    const { report } = await verifyFindings(args(ctx));
    const failed = report.checks.filter((c) => c.status === 'fail').map((c) => c.name);
    expect(failed).to.include.members(['numbers_match', 'candidates_known']);
  });

  it('rejects reference urls that were not seen in tool results', async () => {
    const ctx = baseContext();
    ctx.findings.items[0].reference_urls = ['https://docs.communityhealthtoolkit.org/never-fetched/'];
    const { report } = await verifyFindings(args(ctx));
    expect(report.checks.find((c) => c.name === 'links_allowlisted').status).to.equal('fail');
  });

  it('short-circuits on a schema failure', async () => {
    const ctx = baseContext();
    ctx.findings.items[0].severity = 'urgent';
    const { report, items } = await verifyFindings(args(ctx));
    expect(report.outcome).to.equal('rejected');
    expect(report.checks[0]).to.include({ name: 'schema', status: 'fail' });
    expect(items).to.deep.equal([]);
  });

  it('accepts attempts 1 to 3 and throws on 4', async () => {
    const ctx = baseContext();
    for (const attempt of [1, 2, 3]) {
      const { report } = await verifyFindings(args(ctx, { attempt }));
      expect(report.attempt).to.equal(attempt);
    }
    await expect(verifyFindings(args(ctx, { attempt: 4 }))).to.be.rejectedWith(/attempt/);
  });

  it('resolves links through the injected resolver and records failures', async () => {
    const ctx = baseContext();
    ctx.findings.items[0].reference_urls = ['https://docs.communityhealthtoolkit.org/hosting/monitoring/'];
    const notFound = { ok: false, status: 404, reason: 'HTTP 404' };
    const resolveLinks = sinon.stub().callsFake(async (urls) => new Map(urls.map((u) => [u, notFound])));
    const { report } = await verifyFindings(args(ctx, { resolveLinks, grafanaUrl: 'https://watchdog.example.org' }));
    expect(resolveLinks).to.have.been.calledOnce;
    const urls = resolveLinks.firstCall.args[0];
    expect(urls).to.include('https://docs.communityhealthtoolkit.org/hosting/monitoring/');
    expect(urls.some((u) => u.startsWith('https://watchdog.example.org/d/oa2OfL-Vk/'))).to.equal(true);
    expect(report.checks.find((c) => c.name === 'links_resolve').status).to.equal('fail');
  });

  it('verifies a brief with five bullets and rejects a sixth (FR-010, revision 9)', async () => {
    const ctx = briefContext();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(12));
    ctx.items = ids.map((id) => ({ ...ctx.items[0], item_id: id }));
    ctx.draft.bullets = ids.slice(0, 5).map((id) => ({ item_id: id, text: 'cht.example.org backlog 912 vs 300' }));
    ctx.draft.thread_order = ids;
    const good = await verifyBrief({
      draft: ctx.draft, items: ctx.items, discovery: ctx.discovery, changes: ctx.changes, runId: '2026-09-18',
      attempt: 2, allowlist: ctx.allowlist,
    });
    expect(good.report.outcome).to.equal('accepted');
    expect(good.report.subject).to.equal('brief');
    expect(good.report.subject_ref).to.equal('rollup/draft2');
    expect(schemas.VerificationReport.parse(good.report)).to.be.an('object');
    ctx.draft.bullets.push({ item_id: ids[5], text: 'six' });
    const bad = await verifyBrief({
      draft: ctx.draft, items: ctx.items, discovery: ctx.discovery, changes: ctx.changes, runId: '2026-09-18',
      attempt: 3, allowlist: ctx.allowlist,
    });
    expect(bad.report.outcome).to.equal('rejected');
    expect(bad.report.checks.find((c) => c.name === 'bullet_count').status).to.equal('fail');
  });

  it('verifies a brief against its body layout: one bullet per body item, sub-bullets one line', async () => {
    const ctx = briefContext();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((c) => c.repeat(12));
    ctx.items = ids.map((id) => ({ ...ctx.items[0], item_id: id }));
    const layout = {
      slots: [
        { slot: 1, kind: 'group', group: 'North Programme', item_ids: ids.slice(0, 6), one_line: true },
        { slot: 2, kind: 'item', group: 'Other', item_ids: [ids[6]], one_line: false },
      ],
      body_items: ids, thread_items: [], one_line: ids.slice(0, 6),
    };
    ctx.draft.bullets = ids.map((id) => ({ item_id: id, text: 'cht.example.org backlog 912 vs 300' }));
    ctx.draft.thread_order = ids;
    const verify = (draft) => verifyBrief({
      draft, items: ctx.items, discovery: ctx.discovery, changes: ctx.changes, runId: '2026-09-18', attempt: 1,
      allowlist: ctx.allowlist, layout,
    });
    const good = await verify(ctx.draft);
    const failures = JSON.stringify(good.report.checks.filter((c) => c.status === 'fail'));
    expect(good.report.outcome, failures).to.equal('accepted');
    const bullets = ctx.draft.bullets.map((b, i) => (i === 0 ? { ...b, text: 'one\ntwo' } : b));
    const twoLines = { ...ctx.draft, bullets };
    const long = await verify(twoLines);
    expect(long.report.checks.find((c) => c.name === 'bullet_length').status).to.equal('fail');
    const wrongIds = { ...ctx.draft, bullets: ctx.draft.bullets.slice(1), thread_order: [...ids.slice(1), ids[0]] };
    const mismatch = await verify(wrongIds);
    expect(mismatch.report.outcome).to.equal('rejected');
    const failed = mismatch.report.checks.filter((c) => c.status === 'fail').map((c) => c.name);
    expect(failed).to.include.members(['bullet_count', 'thread_order']);
  });
});
