const { scrub, maskEmail, maskPhone, SLACK_USER_ID } = require('../../src/corpus/scrub');

describe('corpus/scrub (FR-033)', () => {
  it('masks secrets and records only the pattern name, never the secret', () => {
    const { text, flags } = scrub('token xoxb-1234-abcd leaked and key sk-ant-abc123 too');
    expect(text).to.equal('token [secret] leaked and key [secret] too');
    expect(flags).to.deep.equal([
      { kind: 'secret', excerpt: 'slack_token' },
      { kind: 'secret', excerpt: 'anthropic_key' },
    ]);
    expect(JSON.stringify(flags)).to.not.include('xoxb').and.not.include('abc123');
  });

  it('masks e-mail addresses and phone numbers, keeping only a hint in the flag', () => {
    const { text, flags } = scrub('write to jane.doe@example.org or call +254 712 345 678 today');
    expect(text).to.equal('write to [address] or call [address] today');
    expect(flags).to.deep.equal([
      { kind: 'address', excerpt: 'j***@example.org' },
      { kind: 'address', excerpt: '+*** *** *** *78' },
    ]);
    expect(maskEmail('ops@medic.org')).to.equal('o***@medic.org'); // scan-secrets:allow
    expect(maskPhone('0712-345-678')).to.equal('****-***-*78');
  });

  it('masks discovered hosts and other project-like hosts but leaves allowed hosts alone', () => {
    const input = 'Seen on Alpha.example.org and cht.south.example.org; see https://docs.communityhealthtoolkit.org/x and github.com/medic';
    const { text, flags } = scrub(input, {
      hosts: ['alpha.example.org'],
      allowedHosts: ['docs.communityhealthtoolkit.org', 'github.com'],
    });
    expect(text).to.equal('Seen on [hostname] and [hostname]; see https://docs.communityhealthtoolkit.org/x and github.com/medic');
    expect(flags).to.deep.equal([
      { kind: 'hostname', excerpt: 'Alpha.example.org' },
      { kind: 'hostname', excerpt: 'cht.south.example.org' },
    ]);
  });

  it('masks Slack user ids, mentions and named persons', () => {
    const input = 'Reported by <@U0123ABCD> and U04XYZ1234; Jane Doe agreed, so did jane doe.';
    const { text, flags } = scrub(input, { persons: ['Jane Doe'] });
    expect(text).to.equal('Reported by [person] and [person]; [person] agreed, so did [person].');
    expect(flags).to.deep.equal([
      { kind: 'person', excerpt: 'U0123ABCD' },
      { kind: 'person', excerpt: 'U04XYZ1234' },
      { kind: 'person', excerpt: 'Jane Doe' },
    ]);
    expect(SLACK_USER_ID.test('U0123ABCD')).to.equal(true);
    expect(SLACK_USER_ID.test('UNAVAILABLE')).to.equal(false);
  });

  it('leaves metric names, version numbers, file names, ids and ordinary prose untouched', () => {
    const input = 'cht_sentinel_backlog_count rose 3.2x on CHT 4.11.0; see prompts/pass-first.md and memory.md, '
      + 'item 0123456789ab, i.e. the usual month-end pattern (UNAVAILABLE is not a user id).';
    const { text, flags } = scrub(input, { hosts: ['alpha.example.org'] });
    expect(text).to.equal(input);
    expect(flags).to.deep.equal([]);
  });

  it('resolves overlaps in favour of the earlier kind and de-duplicates flags by kind and excerpt', () => {
    const input = 'ops@alpha.example.org wrote twice: alpha.example.org, alpha.example.org.';
    const { text, flags } = scrub(input, { hosts: ['alpha.example.org'] });
    expect(text).to.equal('[address] wrote twice: [hostname], [hostname].');
    expect(flags).to.deep.equal([
      { kind: 'address', excerpt: 'o***@alpha.example.org' },
      { kind: 'hostname', excerpt: 'alpha.example.org' },
    ]);
  });

  it('returns the same text and no flags for clean or empty input', () => {
    expect(scrub('')).to.deep.equal({ text: '', flags: [] });
    expect(scrub(null)).to.deep.equal({ text: '', flags: [] });
    expect(scrub('nothing to see')).to.deep.equal({ text: 'nothing to see', flags: [] });
  });
});

describe('corpus/scrub: the one masker for notes and memory (FR-029, FR-044, revision 36)', () => {
  const { maskNote, maskPersonalData } = require('../../src/corpus/scrub');

  it('masks Slack ids, mentions, e-mail addresses and phone numbers with separators, and nothing else', () => {
    const text = 'ask <@U024BE7LH> or U024BE7LH at +254 712 345 678 / ops@example.org; '
      + 'trailing mean 26.263157894736842; '
      + 'disk 1073741824 bytes; window 2026-09-20 - 2026-09-24; upgraded to 5.2.0-10700-photo-capture.29102352761 '
      + 'on 2026-09-20 06:00 UTC; daily peaks 300 310 305; hosting said so';
    const out = maskNote(text);
    expect(out).to.equal('ask [person] or [person] at [address] / [address]; trailing mean 26.263157894736842; '
      + 'disk 1073741824 bytes; window 2026-09-20 - 2026-09-24; upgraded to 5.2.0-10700-photo-capture.29102352761 '
      + 'on 2026-09-20 06:00 UTC; daily peaks 300 310 305; hosting said so');
    expect(maskNote(null)).to.equal('');
  });

  it('reports what it masked by kind, secrets included, and touches no hostname or name', () => {
    const { text, flags } = maskPersonalData(
      'token xoxb-1234567890-abcdefghij-test on cht.north.example.org, Mark <@U024BE7LH>',
    );
    expect(text).to.include('[secret]').and.include('cht.north.example.org').and.include('Mark [person]');
    expect(flags.map((f) => f.kind).sort()).to.deep.equal(['person', 'secret']);
    expect(maskPersonalData('')).to.deep.equal({ text: '', flags: [] });
  });
});
