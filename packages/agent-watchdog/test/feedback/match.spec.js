const { matchNote } = require('../../src/feedback/match');
const { loadJson } = require('../helpers/fixtures');

describe('feedback/match', () => {
  const items = loadJson('slack', 'items-2026-09-17.json');
  const alpha = items[0];
  const gamma = items[1];

  it('matches an explicit item id first', () => {
    const result = matchNote({ text: `looks fine, see ${gamma.item_id} for context`, items });
    expect(result.item).to.equal(gamma);
    expect(result.how).to.equal('item_id');
  });

  it('matches a host plus a metric written with spaces instead of underscores', () => {
    const result = matchNote({
      text: 'alpha.example.org sentinel backlog: known migration, expected until 1 October', items,
    });
    expect(result.item).to.equal(alpha);
    expect(result.how).to.equal('host+metric');
  });

  it('matches a metric alone when exactly one item carries it', () => {
    expect(matchNote({ text: 'the cht_sentinel_backlog_count jump is expected', items }))
      .to.include({ item: alpha, how: 'metric' });
    expect(matchNote({ text: 'Sentinel Backlog is a known thing', items })).to.include({ item: alpha, how: 'metric' });
  });

  it('matches a host alone when exactly one item belongs to it', () => {
    expect(matchNote({ text: 'gamma.example.org is being migrated this week', items }))
      .to.include({ item: gamma, how: 'host' });
  });

  it('returns unmatched when nothing is referenced or the reference is ambiguous', () => {
    expect(matchNote({ text: 'what is this?', items })).to.deep.equal({ item: null, how: null });
    const twoOnOneHost = [alpha, { ...gamma, project_url: 'https://alpha.example.org', item_id: 'bbbbbbbbbbbb' }];
    expect(matchNote({ text: 'alpha.example.org looks odd', items: twoOnOneHost }))
      .to.deep.equal({ item: null, how: null });
    const sameMetricTwice = [alpha, { ...alpha, item_id: 'cccccccccccc', project_url: 'https://beta.example.org' }];
    expect(matchNote({ text: 'sentinel backlog again', items: sameMetricTwice }))
      .to.deep.equal({ item: null, how: null });
  });

  it('is case-insensitive and tolerates punctuation around the reference', () => {
    expect(matchNote({ text: 'Re: GAMMA.EXAMPLE.ORG, the (up{job="cht"}) drop.', items })).to.include({ item: gamma });
  });
});
