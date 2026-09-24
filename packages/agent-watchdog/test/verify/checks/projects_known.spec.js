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

describe('verify/checks/projects_known: a host written as its leading labels (FR-016, revision 23)', () => {
  const withDeep = () => {
    const ctx = baseContext();
    ctx.discovery.projects.push({
      host: 'cht.north.prod.example.org', url: 'https://cht.north.prod.example.org', slug: 'cht-north-prod-example-org',
    });
    return ctx;
  };

  it('accepts the leading two or more labels of a discovered host as naming that project', () => {
    const ctx = withDeep();
    ctx.items[0].why_now = 'Backlog is 912; cht.north.prod shows the same shape and cht.north.prod.example.org too.';
    expect(check(ctx).status).to.equal('pass');
  });

  it('still refuses a host of another domain, and trailing labels that are not a project', () => {
    const domain = withDeep();
    domain.items[0].why_now = 'Backlog is 912, unlike north.prod.example.org which is fine.';
    expect(check(domain).status).to.equal('fail');
    const other = withDeep();
    other.items[0].why_now = 'Backlog is 912, unlike cht.north.staging.example.org.';
    expect(check(other).status).to.equal('fail');
  });
});

describe('verify/checks/projects_known: the notice names no other host (FR-016, revision 33)', () => {
  const { check } = require('../../../src/verify/checks/projects_known');
  const { briefContext } = require('../helpers/context');

  it('refuses an undiscovered host in the expected-load notice and accepts a discovered one', () => {
    const bad = briefContext();
    bad.draft.expected_load_notice = 'Month-end on evil.partner.org';
    const result = check(bad);
    expect(result.status).to.equal('fail');
    expect(result.reasons)
      .to.deep.equal(['expected_load_notice names evil.partner.org, which is not a discovered project']);
    const ok = briefContext();
    ok.draft.expected_load_notice = 'Month-end on cht.example.org';
    expect(check(ok).status).to.equal('pass');
  });
});
