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
      'schema', 'projects_known', 'metrics_known', 'candidates_known', 'numbers_match', 'dates_match', 'relates_to',
      'links_built', 'links_allowlisted', 'links_resolve', 'severity_rules', 'bullet_count', 'bullet_length',
      'secrets_absent', 'personal_data_absent', 'pattern_cards_known',
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

  it('resolves a relation the analysis named by metric to that sibling\'s identity (revision 20)', async () => {
    const ctx = baseContext();
    const [first] = ctx.findings.items;
    const sibling = JSON.parse(JSON.stringify(first));
    sibling.item_key = { ...sibling.item_key, metric: 'cht_outbound_push_backlog_count' };
    ctx.findings.items = [
      { ...first, relates_to: { metric: 'cht_outbound_push_backlog_count', relation: 'rate_of' } },
      sibling,
    ];
    ctx.windows = [
      ...ctx.windows,
      ...ctx.windows.map((w) => ({ ...w, metric: 'cht_outbound_push_backlog_count' })),
    ];
    const { items } = await verifyFindings(args(ctx));
    expect(items[0].relates_to).to.deep.equal({
      item_id: itemId(URL, 'cht_outbound_push_backlog_count', null),
      metric: 'cht_outbound_push_backlog_count',
      relation: 'rate_of',
    });
    // The sibling names nothing, so it carries null rather than an empty object.
    expect(items[1].relates_to).to.equal(null);
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

  it('verifies a brief of two bullets and rejects a third without a layout (FR-010, revision 28)', async () => {
    const ctx = briefContext();
    const ids = ['a', 'b', 'c'].map((c) => c.repeat(12));
    ctx.items = ids.map((id) => ({ ...ctx.items[0], item_id: id }));
    ctx.draft.bullets = ids.slice(0, 2).map((id) => ({ item_id: id, text: 'cht.example.org backlog 912 vs 300' }));
    ctx.draft.thread_order = ids;
    const good = await verifyBrief({
      draft: ctx.draft, items: ctx.items, discovery: ctx.discovery, changes: ctx.changes, runId: '2026-09-18',
      attempt: 2, allowlist: ctx.allowlist,
    });
    expect(good.report.outcome).to.equal('accepted');
    expect(good.report.subject).to.equal('brief');
    expect(good.report.subject_ref).to.equal('rollup/draft2');
    expect(schemas.VerificationReport.parse(good.report)).to.be.an('object');
    ctx.draft.bullets.push({ item_id: ids[2], text: 'three' });
    const bad = await verifyBrief({
      draft: ctx.draft, items: ctx.items, discovery: ctx.discovery, changes: ctx.changes, runId: '2026-09-18',
      attempt: 3, allowlist: ctx.allowlist,
    });
    expect(bad.report.outcome).to.equal('rejected');
    expect(bad.report.checks.find((c) => c.name === 'bullet_count').status).to.equal('fail');
  });

  it('verifies a brief against its layout: one text per entry, body slots then replies, two lines each', async () => {
    const { buildLayout } = require('../../src/rollup/layout');
    const ctx = briefContext();
    const hosts = { a: 'north-a', b: 'north-b', c: 'north-c', d: 'north-a', e: 'alpha', f: 'south-a', g: 'south-b' };
    ctx.items = Object.entries(hosts).map(([c, host]) => ({
      ...ctx.items[0], item_id: c.repeat(12), project_url: `https://${host}.example.org`,
    }));
    const groupOf = (url) => {
      if (/north/.test(url)) {
        return 'North Programme';
      }
      return /south/.test(url) ? 'South Programme' : 'Other';
    };
    const layout = buildLayout(ctx.items, { groupOf });
    // North (three lines; d rides on a's line) and alpha fill the body; South's two projects are a thread reply.
    expect(layout.body_items).to.deep.equal(['a', 'b', 'c', 'e'].map((c) => c.repeat(12)));
    expect(layout.reply_items).to.deep.equal(['f', 'g'].map((c) => c.repeat(12)));
    const leads = [...layout.body_items, ...layout.reply_items];
    ctx.draft.bullets = leads.map((id) => ({ item_id: id, text: 'backlog 912 vs 300' }));
    ctx.draft.thread_order = [...leads, 'd'.repeat(12)];
    const verify = (draft) => verifyBrief({
      draft, items: ctx.items, discovery: ctx.discovery, changes: ctx.changes, runId: '2026-09-18', attempt: 1,
      allowlist: ctx.allowlist, layout,
    });
    const good = await verify(ctx.draft);
    const failures = JSON.stringify(good.report.checks.filter((c) => c.status === 'fail'));
    expect(good.report.outcome, failures).to.equal('accepted');
    const withFirst = (text) => ({
      ...ctx.draft, bullets: ctx.draft.bullets.map((b, i) => (i === 0 ? { ...b, text } : b)),
    });
    // Every entry may take two lines (revision 28); a third line, or a first line over the budget the prefix
    // leaves, is rejected.
    const twoLines = await verify(withFirst('backlog 912\nvs 300'));
    expect(twoLines.report.outcome, JSON.stringify(twoLines.report.checks)).to.equal('accepted');
    const threeLines = await verify(withFirst('backlog 912\nvs\n300'));
    expect(threeLines.report.checks.find((c) => c.name === 'bullet_length').status).to.equal('fail');
    const long = await verify(withFirst(`backlog 912 vs 300 ${'x'.repeat(100)}`));
    expect(long.report.checks.find((c) => c.name === 'bullet_length').status).to.equal('fail');
    const wrongIds = {
      ...ctx.draft, bullets: ctx.draft.bullets.slice(1), thread_order: [...leads.slice(1), leads[0], 'd'.repeat(12)],
    };
    const mismatch = await verify(wrongIds);
    expect(mismatch.report.outcome).to.equal('rejected');
    const failed = mismatch.report.checks.filter((c) => c.status === 'fail').map((c) => c.name);
    expect(failed).to.include.members(['bullet_count', 'thread_order']);
  });
});

describe('verify/gate: a relation to the item\'s own metric is dropped, not rejected (FR-009, revision 24)', () => {
  const { baseContext, URL } = require('./helpers/context');
  const { verifyFindings } = require('../../src/verify/gate');
  const args = (ctx) => ({
    findings: ctx.findings, pass: 1, project: ctx.project, discovery: ctx.discovery, changes: ctx.changes,
    candidates: ctx.candidates, windows: ctx.windows, knownCards: ctx.knownCards, allowlist: ctx.allowlist,
    toolResultUrls: ctx.toolResultUrls, resolveLinks: null, grafanaUrl: null,
  });

  it('normalises a self-reference to null and accepts the pass', async () => {
    const ctx = baseContext();
    const [first] = ctx.findings.items;
    ctx.findings.items = [{ ...first, relates_to: { metric: first.item_key.metric, relation: 'same_cause' } }];
    const { report, items } = await verifyFindings(args(ctx));
    expect(items[0].relates_to).to.equal(null);
    expect(items[0].project_url).to.equal(URL);
    const relates = report.checks.find((c) => c.name === 'relates_to');
    expect(relates.status).to.equal('pass');
  });
});

describe('verify/gate: what the resolver may request (FR-083, revision 33)', () => {
  const { EgressRefusedError } = require('../../src/net/egress');
  const okAll = () => sinon.stub().callsFake(async (urls) => new Map(
    urls.map((u) => [u, { ok: true, status: 200, reason: 'ok' }]),
  ));

  it('sends the resolver only built links and model references allow-listed and seen in a tool result', async () => {
    const ctx = baseContext();
    ctx.findings.items[0].reference_urls = [
      'https://docs.communityhealthtoolkit.org/hosting/monitoring/',
      'https://docs.communityhealthtoolkit.org/never-fetched/',
      'https://evil.example.org/exfiltrate',
    ];
    const resolveLinks = okAll();
    const { report } = await verifyFindings(args(ctx, { resolveLinks, grafanaUrl: 'https://watchdog.example.org' }));
    const urls = resolveLinks.firstCall.args[0];
    expect(urls).to.include('https://docs.communityhealthtoolkit.org/hosting/monitoring/');
    expect(urls.some((u) => u.startsWith('https://watchdog.example.org/d/'))).to.equal(true);
    expect(urls).to.not.include('https://docs.communityhealthtoolkit.org/never-fetched/');
    expect(urls).to.not.include('https://evil.example.org/exfiltrate');
    const resolve = report.checks.find((c) => c.name === 'links_resolve');
    expect(resolve.status).to.equal('fail');
    expect(resolve.reasons.join(' ')).to.include('never-fetched');
    expect(resolve.reasons.join(' ')).to.include('not requested');
  });

  it('resolves the accepted items\' allow-listed references for a brief, which has no tool results', async () => {
    const ctx = briefContext();
    ctx.items[0].reference_urls = ['https://docs.communityhealthtoolkit.org/hosting/monitoring/'];
    const resolveLinks = okAll();
    await verifyBrief({
      draft: ctx.draft, items: ctx.items, discovery: ctx.discovery, changes: ctx.changes, candidates: ctx.candidates,
      runId: 'r', allowlist: ctx.allowlist, resolveLinks,
      extraUrls: ['https://watchdog.example.org/alerting/list?search=x'],
    });
    const urls = resolveLinks.firstCall.args[0];
    expect(urls).to.include('https://docs.communityhealthtoolkit.org/hosting/monitoring/');
    expect(urls).to.include('https://watchdog.example.org/alerting/list?search=x');
  });

  it('lets an egress refusal from the resolver fail the run instead of reading as a broken link', async () => {
    const ctx = baseContext();
    ctx.findings.items[0].reference_urls = ['https://docs.communityhealthtoolkit.org/hosting/monitoring/'];
    const refused = new EgressRefusedError({ host: 'docs.communityhealthtoolkit.org', port: 443 });
    const resolveLinks = sinon.stub().rejects(refused);
    await expect(verifyFindings(args(ctx, { resolveLinks }))).to.be.rejectedWith(EgressRefusedError);
  });
});

describe('verify/gate: a cited link outside the egress list rejects the link, not the run (revision 36)', () => {
  const { createResolver } = require('../../src/links/resolve');
  const { buildEgress, guardFetch } = require('../../src/net/egress');
  const { config } = require('./helpers/context');

  it('fails links_resolve for the link and completes the pass', async () => {
    const ctx = baseContext();
    const url = 'https://docs.communityhealthtoolkit.org:8443/hosting/monitoring/';
    ctx.findings.items[0].reference_urls = [url];
    ctx.toolResultUrls = new Set([url]);
    const egress = buildEgress(config);
    const inner = sinon.stub().resolves(new Response(null, { status: 200 }));
    const resolveLinks = createResolver({
      fetch: guardFetch(inner, egress), timeoutMs: 50, discovery: ctx.discovery, grafanaUrl: null,
      allowlist: ctx.allowlist,
      egress,
    });
    const { report } = await verifyFindings(args(ctx, { resolveLinks }));
    expect(report.outcome).to.equal('rejected');
    const resolve = report.checks.find((c) => c.name === 'links_resolve');
    expect(resolve.reasons.join(' ')).to.include('outside the egress list');
    expect(inner.called).to.equal(false);
  });
});
