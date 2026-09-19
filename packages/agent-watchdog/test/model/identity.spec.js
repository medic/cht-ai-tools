const crypto = require('node:crypto');
const identity = require('../../src/model/identity');

describe('model/identity', () => {
  it('derives item_id as the first 12 hex characters of sha256 over project_url, metric and pattern', () => {
    const expected = crypto.createHash('sha256').update('https://cht.example.org\ncht_sentinel_backlog_count\nnone').digest('hex').slice(0, 12);
    expect(identity.itemId('https://cht.example.org', 'cht_sentinel_backlog_count', null)).to.equal(expected);
    expect(identity.itemId('https://cht.example.org', 'cht_sentinel_backlog_count', undefined)).to.equal(expected);
    expect(identity.itemId('https://cht.example.org', 'cht_sentinel_backlog_count', 'sentinel-stall')).to.not.equal(expected);
    expect(identity.itemId('https://cht.example.org', 'cht_sentinel_backlog_count', 'sentinel-stall')).to.match(/^[0-9a-f]{12}$/);
  });

  it('is stable across severity, values and wording', () => {
    const a = identity.itemId('https://a', 'm', 'p');
    expect(identity.itemId('https://a', 'm', 'p')).to.equal(a);
  });

  it('formats and parses run ids', () => {
    expect(identity.runIdFor('2026-09-18')).to.equal('2026-09-18');
    expect(identity.runIdFor('2026-09-18', 2)).to.equal('2026-09-18-f2');
    expect(identity.parseRunId('2026-09-18-f2')).to.deep.equal({ date: '2026-09-18', force: 2 });
    expect(identity.parseRunId('2026-09-18')).to.deep.equal({ date: '2026-09-18', force: 0 });
    expect(() => identity.parseRunId('yesterday')).to.throw();
  });

  it('hashes candidate and feedback ids over their identity fields', () => {
    const c = identity.candidateId('https://a', 'm', 'pct_change', '2026-09-18');
    expect(c).to.match(/^[0-9a-f]{12}$/);
    expect(identity.candidateId('https://a', 'm', 'deviation', '2026-09-18')).to.not.equal(c);
    const f = identity.feedbackId('1726000000.000100', 'U1', 'reaction', 'up');
    expect(f).to.match(/^[0-9a-f]{12}$/);
    expect(identity.feedbackId('1726000000.000100', 'U1', 'reaction', 'down')).to.not.equal(f);
  });

  it('derives a project slug from a host', () => {
    expect(identity.projectSlug('cht.example.org')).to.equal('cht-example-org');
    expect(identity.projectSlug('cht.example.org:8443')).to.equal('cht-example-org-8443');
  });
});
