const { check } = require('../../../src/verify/checks/secrets_absent');
const { SECRET_PATTERNS } = require('../../../src/verify/patterns');
const { baseContext, briefContext } = require('../helpers/context');

describe('verify/checks/secrets_absent', () => {
  it('passes ordinary findings and briefs', () => {
    expect(check(baseContext()).status).to.equal('pass');
    expect(check(briefContext()).status).to.equal('pass');
  });

  it('fails on Slack, Anthropic and Grafana token shapes and bearer strings anywhere in the document', () => {
    for (const secret of ['xoxb-123-abc', 'sk-ant-api03-xyz', 'glsa_abcDEF123', 'Bearer abcdefghijklmnop1234']) {
      const ctx = baseContext();
      ctx.findings.items[0].suggested_check = `use ${secret} to check`;
      const result = check(ctx);
      expect(result.status, secret).to.equal('fail');
      expect(result.reasons[0]).to.not.include(secret.slice(-6));
    }
  });

  it('exports named patterns', () => {
    expect(SECRET_PATTERNS.map((p) => p.name))
      .to.include.members(['slack_token', 'anthropic_key', 'grafana_token', 'bearer']);
  });
});
