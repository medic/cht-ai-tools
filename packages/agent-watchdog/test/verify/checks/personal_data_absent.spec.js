const { check } = require('../../../src/verify/checks/personal_data_absent');
const { baseContext } = require('../helpers/context');

describe('verify/checks/personal_data_absent', () => {
  it('passes text with hosts, versions, timestamps and counts', () => {
    const ctx = baseContext();
    ctx.findings.items[0].why_now = 'cht.example.org on 4.11.0 since 2026-09-17T06:00:00Z '
      + 'with 1,200,000 docs and 2592000 s';
    expect(check(ctx).status).to.equal('pass');
  });

  it('does not mistake a version string with long digit runs for a phone number', () => {
    const ctx = baseContext();
    ctx.findings.items[0].why_now = 'running 5.2.0-10700-photo-capture.29102352761-1783696221314 since Monday';
    expect(check(ctx).status).to.equal('pass');
  });

  it('does not mistake an unrounded computed value for a phone number (revision 18)', () => {
    const ctx = baseContext();
    // The trailing daily mean as the run computes it: seventeen digits and a decimal point.
    ctx.findings.items[0].why_now = 'far above the trailing daily mean of 26.263157894736842 docs';
    expect(check(ctx).status).to.equal('pass');
    const ctx2 = baseContext();
    ctx2.findings.items[0].suggested_check = 'compare 1234567890.5 with 0.000123456789';
    expect(check(ctx2).status).to.equal('pass');
    // A phone number written with a dot separator has more than one group, so it is still caught, and so is
    // a bare run of digits, which is what an unformatted number looks like.
    const ctx3 = baseContext();
    ctx3.findings.items[0].why_now = 'call 254.712.345.678 for the on-call rota';
    expect(check(ctx3).reasons[0]).to.include('phone');
    const ctx4 = baseContext();
    ctx4.findings.items[0].why_now = 'call 254712345678 for the on-call rota';
    expect(check(ctx4).reasons[0]).to.include('phone');
  });

  it('does not mistake a nine-plus digit count that equals a computed value for a phone number (revision 22)', () => {
    // A document count as the run holds it: ten digits, no separators. It is the item's own evidence value.
    const ctx = baseContext();
    ctx.items[0].evidence[0].value = 9532463080;
    ctx.findings.items[0].evidence[0].value = 9532463080;
    ctx.findings.items[0].why_now = 'the increase over the window is 9532463080 documents';
    expect(check(ctx).status).to.equal('pass');
    // A byte count that is a computed change for the item's metric, not written in the evidence.
    const ctx2 = baseContext();
    ctx2.changes[0].current_value = 1795907584;
    ctx2.findings.items[0].suggested_check = 'resident memory reached 1795907584 bytes';
    expect(check(ctx2).status).to.equal('pass');
  });

  it('still flags a nine-plus digit run that matches nothing computed, in an item or outside one (revision 22)', () => {
    const ctx = baseContext();
    ctx.findings.items[0].why_now = 'call 9876543210 for the on-call rota';
    expect(check(ctx).reasons[0]).to.include('phone');
    // Outside items[] there is no computed value to compare with, so the rule is unchanged.
    const ctx2 = baseContext();
    ctx2.items[0].evidence[0].value = 9532463080;
    ctx2.findings.items[0].evidence[0].value = 9532463080;
    ctx2.findings.notes = 'ring 9532463080 tonight';
    expect(check(ctx2).reasons[0]).to.include('phone');
  });

  it('does not mistake a date or a date and time for a phone number (revision 19)', () => {
    const ctx = baseContext();
    // Both forms were reported against fetched CHT documentation in run 2026-09-20.
    ctx.findings.items[0].why_now = 'the release notes are dated 2024-07-16 15:04 and 2025-08-20 13:22';
    expect(check(ctx).status).to.equal('pass');
    const ctx2 = baseContext();
    ctx2.findings.items[0].suggested_check = 'compare the 2026-09-18 window with 2026-09-19';
    expect(check(ctx2).status).to.equal('pass');
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
