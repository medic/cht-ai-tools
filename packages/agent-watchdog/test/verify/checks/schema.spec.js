const { check } = require('../../../src/verify/checks/schema');
const { baseContext, briefContext } = require('../helpers/context');

describe('verify/checks/schema', () => {
  it('passes a valid findings document and its normalised items', () => {
    const result = check(baseContext());
    expect(result).to.include({ name: 'schema', status: 'pass' });
  });

  it('fails findings with an unknown field or a bad severity, naming the path', () => {
    const ctx = baseContext();
    ctx.findings.items[0].severity = 'urgent';
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons.join(' ')).to.include('severity');
  });

  it('fails when a normalised item has a confidence outside 0 to 1', () => {
    const ctx = baseContext();
    ctx.items[0].confidence = 1.5;
    expect(check(ctx).status).to.equal('fail');
  });

  it('validates a brief draft in brief mode', () => {
    expect(check(briefContext()).status).to.equal('pass');
    const ctx = briefContext();
    ctx.draft.headline = 5;
    expect(check(ctx).status).to.equal('fail');
  });
});
