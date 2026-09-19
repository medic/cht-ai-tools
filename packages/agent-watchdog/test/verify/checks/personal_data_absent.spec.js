const { check } = require('../../../src/verify/checks/personal_data_absent');
const { baseContext } = require('../helpers/context');

describe('verify/checks/personal_data_absent', () => {
  it('passes text with hosts, versions, timestamps and counts', () => {
    const ctx = baseContext();
    ctx.findings.items[0].why_now = 'cht.example.org on 4.11.0 since 2026-09-17T06:00:00Z '
      + 'with 1,200,000 docs and 2592000 s';
    expect(check(ctx).status).to.equal('pass');
  });

  it('fails on e-mail addresses and phone numbers', () => {
    const ctx = baseContext();
    ctx.findings.items[0].why_now = 'ask ops@medic.org';
    expect(check(ctx).reasons[0]).to.include('e-mail');
    const ctx2 = baseContext();
    ctx2.findings.items[0].suggested_check = 'call +254 712 345 678';
    expect(check(ctx2).reasons[0]).to.include('phone');
  });
});

describe('personal_data_absent: identifier fields', () => {
  const { check } = require('../../../src/verify/checks/personal_data_absent');

  it('does not mistake an all-digit candidate id for a phone number', () => {
    const findings = { items: [{ candidate_ids: ['123456789012', 'ba9876543210'], why_now: 'no digits here' }] };
    const result = check({ mode: 'findings', findings, discovery: { projects: [] } });
    expect(result.status).to.equal('pass');
  });

  it('still flags a phone number in prose', () => {
    const findings = { items: [{ candidate_ids: ['123456789012'], why_now: 'call +254 712 345 678 now' }] };
    const result = check({ mode: 'findings', findings, discovery: { projects: [] } });
    expect(result.status).to.equal('fail');
  });
});
