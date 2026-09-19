const { createResolver } = require('../../src/links/resolve');
const { baseContext } = require('../verify/helpers/context');

const response = (status, headers = {}) => new Response(null, { status, headers });

describe('links/resolve', () => {
  const grafanaUrl = 'https://watchdog.example.org';

  it('resolves Grafana links from discovery without a request', async () => {
    const ctx = baseContext();
    const fetch = sinon.stub();
    const resolve = createResolver({
      fetch, timeoutMs: 100, discovery: ctx.discovery, grafanaUrl, allowlist: ctx.allowlist,
    });
    const results = await resolve([
      `${grafanaUrl}/d/oa2OfL-Vk/cht-admin-overview?orgId=1&viewPanel=panel-3`,
      `${grafanaUrl}/d/oa2OfL-Vk/cht-admin-overview?orgId=1&viewPanel=panel-99`,
      `${grafanaUrl}/d/unknown/x`,
    ]);
    expect(fetch).to.not.have.been.called;
    expect(results.get(`${grafanaUrl}/d/oa2OfL-Vk/cht-admin-overview?orgId=1&viewPanel=panel-3`).ok).to.equal(true);
    expect(results.get(`${grafanaUrl}/d/oa2OfL-Vk/cht-admin-overview?orgId=1&viewPanel=panel-99`).ok).to.equal(false);
    expect(results.get(`${grafanaUrl}/d/unknown/x`).reason).to.include('dashboard');
  });

  it('accepts 2xx and 3xx from HEAD, falls back to GET on 405, and rejects 404', async () => {
    const ctx = baseContext();
    const fetch = sinon.stub();
    fetch.withArgs('https://docs.communityhealthtoolkit.org/a/').resolves(response(200));
    fetch.withArgs('https://forum.communityhealthtoolkit.org/t/1', sinon.match({ method: 'HEAD' })).resolves(response(405));
    fetch.withArgs('https://forum.communityhealthtoolkit.org/t/1', sinon.match({ method: 'GET' })).resolves(response(200));
    fetch.withArgs('https://docs.communityhealthtoolkit.org/missing/').resolves(response(404));
    const resolve = createResolver({
      fetch, timeoutMs: 100, discovery: ctx.discovery, grafanaUrl, allowlist: ctx.allowlist,
    });
    const results = await resolve([
      'https://docs.communityhealthtoolkit.org/a/', 'https://forum.communityhealthtoolkit.org/t/1',
      'https://docs.communityhealthtoolkit.org/missing/',
    ]);
    expect(results.get('https://docs.communityhealthtoolkit.org/a/')).to.include({ ok: true, status: 200 });
    expect(results.get('https://forum.communityhealthtoolkit.org/t/1')).to.include({ ok: true, status: 200 });
    expect(results.get('https://docs.communityhealthtoolkit.org/missing/')).to.include({ ok: false, status: 404 });
    expect(fetch.withArgs('https://forum.communityhealthtoolkit.org/t/1').callCount).to.equal(2);
  });

  it('treats a redirect off the allow-list as not ok and a redirect on it as ok', async () => {
    const ctx = baseContext();
    const fetch = sinon.stub();
    fetch.withArgs('https://docs.communityhealthtoolkit.org/moved/').resolves(response(302, { location: 'https://evil.example.com/' }));
    fetch.withArgs('https://docs.communityhealthtoolkit.org/moved2/')
      .resolves(response(301, { location: 'https://docs.communityhealthtoolkit.org/new/' }));
    const resolve = createResolver({
      fetch, timeoutMs: 100, discovery: ctx.discovery, grafanaUrl, allowlist: ctx.allowlist,
    });
    const results = await resolve(['https://docs.communityhealthtoolkit.org/moved/', 'https://docs.communityhealthtoolkit.org/moved2/']);
    expect(results.get('https://docs.communityhealthtoolkit.org/moved/').reason).to.equal('redirected off the allow-list');
    expect(results.get('https://docs.communityhealthtoolkit.org/moved2/').ok).to.equal(true);
  });

  it('records a timeout or network error as not ok and passes a timeout signal', async () => {
    const ctx = baseContext();
    const fetch = sinon.stub().rejects(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
    const resolve = createResolver({
      fetch, timeoutMs: 50, discovery: ctx.discovery, grafanaUrl, allowlist: ctx.allowlist,
    });
    const results = await resolve(['https://docs.communityhealthtoolkit.org/slow/']);
    const result = results.get('https://docs.communityhealthtoolkit.org/slow/');
    expect(result.ok).to.equal(false);
    expect(result.reason).to.match(/timeout|aborted/i);
    expect(fetch.firstCall.args[1].signal).to.be.instanceOf(AbortSignal);
  });
});

describe('resolve: discovery panels keyed by panel_id', () => {
  const { createResolver } = require('../../src/links/resolve');

  it('accepts a Grafana link whose panel exists under panel_id', async () => {
    const discovery = {
      dashboards: [{
        uid: 'oa2OfL-Vk', slug: 'cht-admin-overview', panels: [{ panel_id: 3, title: 'Sentinel Backlog' }],
      }],
    };
    const resolve = createResolver({
      fetch: async () => null, timeoutMs: 100, discovery, grafanaUrl: 'https://watchdog.example.org',
    });
    const url = 'https://watchdog.example.org/d/oa2OfL-Vk/cht-admin-overview?orgId=1&viewPanel=panel-3';
    const result = await resolve([url]);
    expect(result.get(url).ok).to.equal(true);
  });
});
