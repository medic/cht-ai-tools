// FR-085 (revision 29): where the feedback acted, read back from what the run wrote: the item's records' lines
// in the feedback block of the project's prompt, the suppression it caused, and the run's trace.
const { provenanceFor, feedbackBlockOf, QUOTED_KEYS } = require('../../src/publish/provenance');
const { wrapUntrusted, sanitiseData } = require('../../src/agent/prompt-assembly');
const { RunDir } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

const ALPHA = 'aaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbb';
const project = { url: 'https://alpha.example.org', slug: 'alpha-example-org' };
const record = (overrides = {}) => ({
  feedback_id: 'f1f1f1f1f1f1', date: '2026-09-19', run_id: '2026-09-18', target: 'item', item_id: ALPHA,
  alert_key: null, kind: 'note', verdict: null, note: 'known migration, expected until 1 October',
  horizon: '2026-10-01',
  author: 'U0123ABCD', matched: true, source_ts: '1700000000.000200', acknowledged_run_id: null,
  classification: null, proposal_id: null, ...overrides,
});
const records = [
  record(),
  record({
    feedback_id: 'f2f2f2f2f2f2', verdict: 'up', note: '#1 👍 confirmed', horizon: null, source_ts: '1700000000.000300',
  }),
  record({ feedback_id: 'f3f3f3f3f3f3', item_id: OTHER, note: 'someone else\'s item', horizon: null }),
];
// The block exactly as src/agent/prompt-assembly.js writes it into the pass-1 prompt.
const blockFor = (list) => wrapUntrusted(
  'feedback', JSON.stringify(sanitiseData(list, { dropIdentities: true }), null, 2),
);
const promptText = (list) => [
  '# Pass 1', '', '## Feedback on earlier briefs for this project', '', blockFor(list), '', '## Firing alerts', '',
  'None.', '',
].join('\n');

describe('publish/provenance', () => {
  let dataDir;
  let runDir;
  const run = { run_id: '2026-09-19', trace_url: 'https://langfuse.example.org/trace/t1' };
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-19');
  });
  afterEach(() => removeDir(dataDir));

  const provenance = (overrides = {}) => provenanceFor({
    runDir, run, project, itemId: ALPHA, feedbackIds: new Set(['f1f1f1f1f1f1', 'f2f2f2f2f2f2']), ...overrides,
  });

  it('quotes the kind, verdict, note and horizon lines of the item\'s records as the prompt holds them', async () => {
    const text = promptText(records);
    await runDir.writeText('alpha-example-org/prompt.pass1.md', text);
    const out = await provenance();
    expect(out).to.include({
      applied: 'prompt', prompt_path: 'alpha-example-org/prompt.pass1.md', records: 2,
      trace_url: 'https://langfuse.example.org/trace/t1', suppressed_until: null, suppressed_path: null,
    });
    expect(out.lines).to.deep.equal([
      '"kind": "note",', '"verdict": null,', '"note": "known migration, expected until 1 October",',
      '"horizon": "2026-10-01",',
      '"kind": "note",', '"verdict": "up",', '"note": "#1 👍 confirmed",', '"horizon": null,',
    ]);
    for (const line of out.lines) {
      expect(text, line).to.include(line);
    }
    expect(out.lines_total).to.be.greaterThan(out.lines.length);
    expect(out.lines_total % 2).to.equal(0);
    expect(QUOTED_KEYS).to.deep.equal(['kind', 'verdict', 'note', 'horizon']);
    expect(feedbackBlockOf(text)).to.equal(JSON.stringify(sanitiseData(records, { dropIdentities: true }), null, 2));
  });

  it('points the trace link at the pass-1 generation when the session record kept its observation id', async () => {
    await runDir.writeText('alpha-example-org/prompt.pass1.md', promptText(records));
    await runDir.writeJson('alpha-example-org/session.json', {
      session_id: 's1',
      calls: [{ pass: 1, attempt: 1, observation_id: 'obs1' }, { pass: 2, attempt: 1, observation_id: 'obs2' }],
    });
    expect((await provenance()).trace_url).to.equal('https://langfuse.example.org/trace/t1?observation=obs1');
    const queried = await provenance({ run: { trace_url: 'https://langfuse.example.org/trace/t1?x=1' } });
    expect(queried.trace_url).to.equal('https://langfuse.example.org/trace/t1?x=1&observation=obs1');
    await runDir.writeJson('alpha-example-org/session.json', { session_id: 's1', calls: [{ pass: 1, attempt: 1 }] });
    expect((await provenance()).trace_url).to.equal('https://langfuse.example.org/trace/t1');
    expect((await provenance({ run: {} })).trace_url).to.equal(null);
  });

  it('names the suppression the feedback caused before analysis, alone or beside the prompt', async () => {
    await runDir.writeJson('alpha-example-org/suppressed.json', [
      { candidate_id: 'c1', item_id: ALPHA, horizon: '2026-09-25', reason: 'within the expectation a reviewer noted' },
      { candidate_id: 'c2', item_id: OTHER, horizon: '2026-12-01', reason: 'x' },
    ]);
    const held = await provenance();
    expect(held).to.include({
      applied: 'suppressed', prompt_path: null, records: 0, lines_total: 0, suppressed_until: '2026-09-25',
      suppressed_path: 'alpha-example-org/suppressed.json',
    });
    expect(held.lines).to.deep.equal([]);
    await runDir.writeText('alpha-example-org/prompt.pass1.md', promptText(records));
    expect((await provenance()).applied).to.equal('both');
  });

  it('says the feedback was not used without a prompt, a block, a record of the item or a suppression', async () => {
    const none = await provenance();
    expect(none).to.deep.equal({
      applied: 'none', prompt_path: null, records: 0, lines: [], lines_total: 0,
      trace_url: 'https://langfuse.example.org/trace/t1', suppressed_until: null, suppressed_path: null,
    });
    await runDir.writeText('alpha-example-org/prompt.pass1.md', '# Pass 1\n\nNo feedback recorded for this project.\n');
    expect((await provenance()).applied).to.equal('none');
    await runDir.writeText('alpha-example-org/prompt.pass1.md', promptText([records[2]]));
    const others = await provenance();
    expect(others).to.include({ applied: 'none', prompt_path: 'alpha-example-org/prompt.pass1.md', records: 0 });
    await runDir.writeText('alpha-example-org/prompt.pass1.md', `${wrapUntrusted('feedback', 'not json')}\n`);
    expect((await provenance()).applied).to.equal('none');
  });
});
