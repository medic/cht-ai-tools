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

describe('feedback/match: notes about an alert group (User Story 8)', () => {
  const { matchAlertNote } = require('../../src/feedback/match');
  const groups = [
    { alert_key: 'North Programme/backlog', group: 'North Programme', category: 'backlog' },
    { alert_key: 'North Programme/database', group: 'North Programme', category: 'database' },
    { alert_key: 'South Programme/messaging', group: 'South Programme', category: 'messaging' },
  ];

  it('matches a note naming the programme and the category, or the programme alone when it has one group', () => {
    expect(matchAlertNote({ text: 'the North Programme backlog alerts are a known migration', alertGroups: groups }))
      .to.deep.equal({ alertKey: 'North Programme/backlog' });
    expect(matchAlertNote({ text: 'South Programme alerts: telco outage until Friday', alertGroups: groups }))
      .to.deep.equal({ alertKey: 'South Programme/messaging' });
  });

  it('returns null when the programme is ambiguous, the note names no alerts, or nothing matches', () => {
    expect(matchAlertNote({ text: 'North Programme alerts are fine', alertGroups: groups }))
      .to.deep.equal({ alertKey: null });
    expect(matchAlertNote({ text: 'North Programme is fine', alertGroups: groups })).to.deep.equal({ alertKey: null });
    expect(matchAlertNote({ text: 'nothing to see', alertGroups: groups })).to.deep.equal({ alertKey: null });
    expect(matchAlertNote({ text: 'North Programme backlog alerts', alertGroups: [] }))
      .to.deep.equal({ alertKey: null });
  });
});

describe('feedback/match: citations by rank and inline verdicts (FR-027, revision 23)', () => {
  const { noteVerdict } = require('../../src/feedback/match');
  const items = loadJson('slack', 'items-2026-09-17.json');
  const [alpha, gamma] = items;

  it('resolves #<rank> against the items\' ranks before any other reference', () => {
    expect(matchNote({ text: '#2 :-1: known outage, expected until 1 October', items }))
      .to.include({ item: gamma, how: 'rank' });
    // A rank beats a host or metric named in the same note.
    expect(matchNote({ text: '#2 the alpha.example.org sentinel backlog note applies here too', items }))
      .to.include({ item: gamma, how: 'rank' });
  });

  it('falls through to the other references when no item has the cited rank', () => {
    expect(matchNote({ text: '#99 sentinel backlog is expected', items })).to.include({ item: alpha, how: 'metric' });
    expect(matchNote({ text: '#99', items })).to.deep.equal({ item: null, how: null });
  });

  it('reads a thumbs written in the note as its verdict, and none or both as no verdict', () => {
    expect(noteVerdict('#2 :-1: expected until 1 October')).to.equal('down');
    expect(noteVerdict(':thumbsdown: not useful')).to.equal('down');
    expect(noteVerdict('👎 no')).to.equal('down');
    expect(noteVerdict(':+1: confirmed')).to.equal('up');
    expect(noteVerdict('good catch :thumbsup:')).to.equal('up');
    expect(noteVerdict('👍')).to.equal('up');
    expect(noteVerdict('what is this?')).to.equal(null);
    expect(noteVerdict(':+1: and :-1:')).to.equal(null);
    expect(noteVerdict('')).to.equal(null);
  });
});
