const { check } = require('../../../src/verify/checks/links_allowlisted');
const { baseContext } = require('../helpers/context');

describe('verify/checks/links_allowlisted', () => {
  it('passes reference urls that appeared in tool results and are on the allow-list', () => {
    const ctx = baseContext();
    ctx.items[0].reference_urls = ['https://docs.communityhealthtoolkit.org/hosting/monitoring/'];
    expect(check(ctx).status).to.equal('pass');
  });

  it('fails a url that never appeared in a tool result, even when its host is allowed', () => {
    const ctx = baseContext();
    ctx.items[0].reference_urls = ['https://docs.communityhealthtoolkit.org/other/'];
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('tool result');
  });

  it('fails a url whose host is off the allow-list even when it appeared in a tool result', () => {
    const ctx = baseContext();
    ctx.toolResultUrls.add('https://evil.example.com/x');
    ctx.items[0].reference_urls = ['https://evil.example.com/x'];
    expect(check(ctx).reasons[0]).to.include('allow-list');
  });

  it('fails when the model writes a URL into prose', () => {
    const ctx = baseContext();
    ctx.items[0].why_now = 'See https://docs.communityhealthtoolkit.org/hosting/monitoring/';
    expect(check(ctx).status).to.equal('fail');
  });
});
