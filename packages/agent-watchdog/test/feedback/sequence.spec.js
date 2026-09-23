// FR-085 (revision 29): the notes on one item are one conversation, read in thread order; the last note that
// states a horizon sets the horizon applied, the last that states an expected maximum sets that.
const { threadOrder, clarifiedWhole } = require('../../src/feedback/sequence');

const note = (overrides = {}) => ({
  feedback_id: 'f1f1f1f1f1f1', run_id: '2026-09-17', source_ts: '1758090000.000001', author: 'U1', kind: 'note',
  note: 'a note', horizon: null, ...overrides,
});

describe('feedback/sequence', () => {
  it('orders records by the date of the run whose post they sit under, then by source_ts', () => {
    const records = [
      note({ feedback_id: 'c', run_id: '2026-09-17', source_ts: '1758090000.000009' }),
      note({ feedback_id: 'a', run_id: '2026-09-16-f1', source_ts: '1758090000.000005' }),
      note({ feedback_id: 'd', run_id: '2026-09-18', source_ts: '1758090000.000001' }),
      note({ feedback_id: 'b', run_id: '2026-09-17', source_ts: '1758090000.000002' }),
    ];
    expect(threadOrder(records).map((r) => r.feedback_id)).to.deep.equal(['a', 'b', 'c', 'd']);
    expect(records.map((r) => r.feedback_id), 'the input is left alone').to.deep.equal(['c', 'a', 'd', 'b']);
  });

  it('applies the last stated horizon and expected maximum, keeps an earlier one a dateless note leaves alone', () => {
    const whole = clarifiedWhole([
      note({ note: 'expected until 1 October', horizon: '2026-10-01', expected_max: 900 }),
      note({ note: 'correction: until 25 September', horizon: '2026-09-25', author: 'U7' }),
      note({ note: 'thanks, noted', horizon: null, author: 'U8' }),
    ]);
    expect(whole).to.deep.equal({
      horizon: '2026-09-25', expected_max: 900, note: 'correction: until 25 September', author_count: 3, notes: 3,
    });
    const restated = clarifiedWhole([
      note({ note: 'until 1 October, up to 900', horizon: '2026-10-01', expected_max: 900 }),
      note({ note: 'make that up to 1200', horizon: null, expected_max: 1200, author: 'U7' }),
    ]);
    expect(restated).to.include({ horizon: '2026-10-01', expected_max: 1200, note: 'until 1 October, up to 900' });
    expect(restated.author_count).to.equal(2);
  });

  it('gives nulls for no notes and counts each author once', () => {
    expect(clarifiedWhole([]))
      .to.deep.equal({ horizon: null, expected_max: null, note: null, author_count: 0, notes: 0 });
    const same = clarifiedWhole([note({ horizon: '2026-10-01' }), note({ horizon: null })]);
    expect(same).to.include({ horizon: '2026-10-01', author_count: 1, notes: 2 });
    const viaText = clarifiedWhole([note({ text: 'via text', note: undefined, horizon: '2026-10-02' })]);
    expect(viaText.note).to.equal('via text');
  });
});
