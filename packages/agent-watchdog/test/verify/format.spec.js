const { formatValue, extractNumbers, codeSpans } = require('../../src/verify/format');

describe('verify/format', () => {
  it('formats integers with thousands separators and other values to three significant figures', () => {
    expect(formatValue(912, 'count')).to.equal('912');
    expect(formatValue(1200, 'count')).to.equal('1,200');
    expect(formatValue(0.31234, 'ratio')).to.equal('0.312');
    expect(formatValue(912.4, 'count')).to.equal('912');
    expect(formatValue(1234.5, 'count')).to.equal('1,230');
    expect(formatValue(null, 'count')).to.equal('');
  });

  it('formats percentages with one decimal and durations as hours or days', () => {
    expect(formatValue(204.0, 'percent')).to.equal('204.0%');
    expect(formatValue(3.456, '%')).to.equal('3.5%');
    expect(formatValue(25200, 's')).to.equal('7h');
    expect(formatValue(172800, 'seconds')).to.equal('2d');
    expect(formatValue(45, 's')).to.equal('45');
    expect(formatValue(7, 'h')).to.equal('7h');
  });

  it('extracts numeric tokens outside code spans, ignoring dates and times', () => {
    const text = 'Backlog rose from 300 to 912 (204.0%) over 7h; see `rate(x[5m])` '
      + 'and 1,200 docs on 2026-09-17 at 06:00.';
    expect(extractNumbers(text)).to.deep.equal(['300', '912', '204.0%', '7h', '1,200']);
    expect(extractNumbers('nothing numeric here')).to.deep.equal([]);
  });

  it('returns the contents of backtick code spans', () => {
    expect(codeSpans('a `x{y="1"}` b `z` c')).to.deep.equal(['x{y="1"}', 'z']);
    expect(codeSpans('no spans')).to.deep.equal([]);
  });
});

describe('verify/format: numerals read one at a time, unit words as units (FR-016, revision 25)', () => {
  const { extractNumbers, extractNumbersEverywhere } = require('../../src/verify/format');

  it('reads a comma as a thousands separator only in groups of three after a first group of up to three digits', () => {
    expect(extractNumbersEverywhere('[[1789538400,390778880],[1789624800,451162112]]'))
      .to.deep.equal(['1789538400', '390778880', '1789624800', '451162112']);
    expect(extractNumbersEverywhere('rose to 1,604,078,240 bytes')).to.deep.equal(['1,604,078,240']);
    expect(extractNumbersEverywhere('[1789538400,0.0008130081300813008]'))
      .to.deep.equal(['1789538400', '0.0008130081300813008']);
    expect(extractNumbers('values 912,300 and 1,234')).to.deep.equal(['912,300', '1,234']);
    expect(extractNumbers('read 1789538400,390778880 bytes')).to.deep.equal(['1789538400', '390778880']);
  });

  it('attaches days and hours written as words the way the letter suffixes already are', () => {
    expect(extractNumbers('up for 7.5 days and 24 hours, then 3 h and 2d')).to.deep.equal(['7.5d', '24h', '3', '2d']);
    expect(extractNumbers('one day of 14 samples')).to.deep.equal(['14']);
  });
});
