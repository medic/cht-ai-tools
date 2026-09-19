const { check } = require('../../../src/verify/checks/projects_known');
const { baseContext, briefContext } = require('../helpers/context');

describe('verify/checks/projects_known', () => {
  it('passes when the findings name the session project and no other host', () => {
    expect(check(baseContext()).status).to.equal('pass');
  });

  it('fails when project_url is not the discovered project', () => {
    const ctx = baseContext();
    ctx.findings.project_url = 'https://other.example.org';
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('other.example.org');
  });

  it('fails when the text mentions a host that is not a discovered project', () => {
    const ctx = baseContext();
    ctx.items[0].why_now = 'Compare with partner.other.org which is fine.';
    expect(check(ctx).status).to.equal('fail');
  });

  it('ignores version numbers, file names and allow-listed documentation hosts', () => {
    const ctx = baseContext();
    ctx.items[0].why_now = 'CHT 4.11.0 on couchdb.log; see docs.communityhealthtoolkit.org';
    expect(check(ctx).status).to.equal('pass');
  });

  it('checks headline and bullets in brief mode', () => {
    expect(check(briefContext()).status).to.equal('pass');
    const ctx = briefContext();
    ctx.draft.bullets[0].text = 'evil.partner.org is down';
    expect(check(ctx).status).to.equal('fail');
  });
});
