const { redactText, REDACTED } = require('../../src/publish/redact');

describe('publish/redact: code text outside the gate is redacted before it is posted (FR-024, revision 27)', () => {
  it('replaces secrets, e-mail addresses and phone-shaped runs and leaves the rest of the message', () => {
    const text = 'Slack said invalid_auth for xoxb-123456-abcdef, contact ops@example.org or +254 712 345 678 now';
    const out = redactText(text);
    expect(out).to.equal(`Slack said invalid_auth for ${REDACTED}, contact ${REDACTED} or ${REDACTED} now`);
    const bearer = 'glsa_AbCdEf123 rejected, Bearer abcdefghijklmnopqrst used'; // scan-secrets:allow
    expect(redactText(bearer)).to.equal(`${REDACTED} rejected, ${REDACTED} used`);
  });

  it('keeps hosts, versions, counts and timestamps, and tolerates empty input', () => {
    const text = 'collect failed for cht.example.org on 4.11.0 at 2026-09-22T06:00:00Z after 1,200,000 docs';
    expect(redactText(text)).to.equal(text);
    expect(redactText(null)).to.equal('');
    expect(redactText(undefined)).to.equal('');
  });
});
