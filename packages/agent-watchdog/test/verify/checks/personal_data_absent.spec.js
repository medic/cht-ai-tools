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
    ctx.findings.items[0].why_now = 'ask ops@medic.org'; // scan-secrets:allow
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

describe('personal_data_absent: brief drafts', () => {
  const { check } = require('../../../src/verify/checks/personal_data_absent');
  const { briefContext } = require('../helpers/context');

  it('checks only what is published; proposals and memory are scrubbed and flagged by code instead (FR-033)', () => {
    const ctx = briefContext();
    const body = 'contact ops@example.org or +254 712 345 678';
    ctx.draft.proposals = [{ type: 'prompt', title: 'Watch alpha', body }];
    ctx.draft.memory_update = { replace_with: 'reviewer U0123ABCD (ops@example.org) confirmed the pattern' };
    expect(check(ctx).status).to.equal('pass');
  });

  it('still fails on personal data in the headline, a bullet or the expected-load notice', () => {
    const headline = briefContext();
    headline.draft.headline = 'Ask ops@example.org about sentinel';
    expect(check(headline).status).to.equal('fail');
    const bullet = briefContext();
    bullet.draft.bullets[0].text = 'call +254 712 345 678';
    expect(check(bullet).reasons[0]).to.include('phone');
    const notice = briefContext();
    notice.draft.expected_load_notice = 'month-end, ask ops@example.org';
    expect(check(notice).status).to.equal('fail');
  });
});
