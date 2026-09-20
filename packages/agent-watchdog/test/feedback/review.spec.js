// FR-061: reactions are tallied by code; each note is classified once by a bounded, schema-validated model call
// into the place its lesson belongs, and every lesson becomes a proposal that a human reviews.
const fs = require('node:fs');
const path = require('node:path');
const { reviewFeedback, splitPrompt, validateProjectsFragment, OUTPUT_SCHEMA } = require('../../src/feedback/review');
const { appendRecords, readAll } = require('../../src/feedback/store');
const { readProposals } = require('../../src/rollup/proposals');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { RunDir, ensureDataLayout } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

const PROMPT = fs.readFileSync(path.join(PACKAGE_PATHS.promptsDir, 'feedback-review.md'), 'utf8');
const ALPHA = '49bd5cd2499f';
const URL = 'https://alpha.example.org';
const config = {
  model: { name: 'claude-fable-5-1', feedback: 'claude-haiku-4-5-20251001', effort: 'max' },
  bounds: { maxTurns: 20, maxBudgetUsdProject: 2, modelTimeoutMs: 900000 },
};
const quiet = { warns: [], info() {}, debug() {}, error() {}, warn(event, fields) {
  quiet.warns.push({ event, ...fields });
} };

const note = (id, text, overrides = {}) => ({
  feedback_id: id, date: '2026-09-18', run_id: '2026-09-17', target: 'item', item_id: ALPHA, kind: 'note',
  verdict: null, note: text, horizon: null, author: 'U04AB12CD', matched: true,
  source_ts: `175800000${id.slice(0, 1)}.000100`,
  ...overrides,
});
const reaction = (id, verdict) => ({
  feedback_id: id, date: '2026-09-18', run_id: '2026-09-17', target: 'item', item_id: ALPHA, kind: 'reaction',
  verdict, note: null, horizon: null, author: 'U04AB12CD', matched: true, source_ts: '1758000009.000100',
});
const byItem = {
  [ALPHA]: {
    project_url: URL, metric: 'cht_sentinel_backlog_count', pattern_card: null, up: 1, down: 2, retracted: 0,
    notes: [], verdict: 'dismissed', horizon: null,
  },
};
const answer = (classification, extra = {}) => ({
  structuredOutput: {
    classification,
    title: `Lesson about ${classification}`,
    lesson: 'A sentinel backlog that only rises on one project during its sync week is expected load.',
    projects_yaml: null,
    rationale: 'Two readers dismissed the item for the same reason.',
    ...extra,
  },
  result: {
    subtype: 'success', usage: { input_tokens: 400, output_tokens: 60, cache_read_tokens: 0, cache_creation_tokens: 0 },
    total_cost_usd: 0.004, num_turns: 1, duration_ms: 40, session_id: 's',
  },
  toolCalls: [],
  referenceUnavailable: false,
});
const engineWith = (answers) => {
  const queue = [...answers];
  return { singleTurn: sinon.stub().callsFake(async () => queue.shift()) };
};

describe('feedback/review (FR-061)', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    quiet.warns.length = 0;
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    runDir = await RunDir.create(dataDir, '2026-09-18');
  });
  afterEach(() => removeDir(dataDir));

  const review = async (records, engine, extra = {}) => {
    await appendRecords(dataDir, records);
    return reviewFeedback({
      dataDir, runDir, runId: '2026-09-18', date: '2026-09-18', records: await readAll(dataDir), byItem, engine, config,
      promptText: PROMPT, hosts: ['alpha.example.org'], persons: ['U04AB12CD'], logger: quiet, ...extra,
    });
  };

  it('splits the prompt file into a system part and the note template, and documents the model', () => {
    const { system, user } = splitPrompt(PROMPT);
    expect(system).to.include('project_annotation');
    expect(system).to.not.include('{{note}}');
    expect(user).to.include('{{item}}').and.include('{{note}}');
    expect(PROMPT).to.include('AGENT_WATCHDOG_MODEL_FEEDBACK');
    expect(OUTPUT_SCHEMA.properties.classification.enum).to.include.members(['expectation', 'none', 'skill']);
  });

  it('never sends reactions to the model and counts them as skipped', async () => {
    const engine = engineWith([]);
    const out = await review([reaction('aaaaaaaaaaaa', 'up'), reaction('bbbbbbbbbbbb', 'down')], engine);
    expect(engine.singleTurn).to.not.have.been.called;
    expect(out).to.include({ skipped_reactions: 2 });
    expect(out.classified).to.deep.equal([]);
  });

  it('classifies each unreviewed note once with the note wrapped as untrusted and no author anywhere', async () => {
    const engine = engineWith([answer('none')]);
    const out = await review([note('cccccccccccc', 'thanks, useful')], engine);
    expect(engine.singleTurn).to.have.been.calledOnce;
    const call = engine.singleTurn.firstCall.args[0];
    expect(call.systemPrompt).to.deep.equal([splitPrompt(PROMPT).system]);
    expect(call.userPrompt).to.include('<untrusted source="feedback-note">\nthanks, useful\n</untrusted>');
    expect(call.userPrompt).to.include('alpha.example.org').and.include('cht_sentinel_backlog_count');
    expect(call.userPrompt).to.not.include('U04AB12CD');
    expect(call.systemPrompt.join('')).to.not.include('U04AB12CD');
    expect(call).to.include({ model: 'claude-haiku-4-5-20251001', effort: 'max', name: 'feedback-review' });
    expect(call.bounds).to.deep.equal({ maxTurns: 20, maxBudgetUsd: 2, timeoutMs: 900000 });
    expect(call.outputSchema).to.equal(OUTPUT_SCHEMA);
    expect(out.classified).to.deep.equal([{
      feedback_id: 'cccccccccccc', item_id: ALPHA, project_url: URL, metric: 'cht_sentinel_backlog_count',
      classification: 'none', proposal_id: null, proposal_path: null, destination: null,
    }]);
    const [stored] = await readAll(dataDir);
    expect(stored).to.include({ classification: 'none', proposal_id: null });
    expect(out.calls).to.have.length(1);
    expect(out.calls[0]).to.include({ stage: 'feedback', pass: null, project_url: URL, cost_usd: 0.004 });
    // A second review does not touch a classified note.
    const again = await reviewFeedback({
      dataDir, runDir, runId: '2026-09-19', date: '2026-09-19', records: await readAll(dataDir), byItem, engine, config,
      promptText: PROMPT, logger: quiet,
    });
    expect(engine.singleTurn).to.have.been.calledOnce;
    expect(again.classified).to.deep.equal([]);
  });

  it('writes a proposal for every destination except expectation and none, recording the id on the note', async () => {
    const engine = engineWith([
      answer('expectation'), answer('skill'), answer('prompt'), answer('threshold'), answer('pattern_card'),
    ]);
    const records = ['1aaaaaaaaaaa', '2bbbbbbbbbbb', '3cccccccccccc'.slice(0, 12), '4ddddddddddd', '5eeeeeeeeeee']
      .map((id, i) => note(id, `note ${i}`, { source_ts: `17580000${i}0.000100` }));
    const out = await review(records, engine);
    expect(out.classified.map((c) => c.classification))
      .to.deep.equal(['expectation', 'skill', 'prompt', 'threshold', 'pattern_card']);
    expect(out.classified[0].proposal_id).to.equal(null);
    const proposals = await readProposals(dataDir);
    expect(proposals.map((p) => p.type).sort()).to.deep.equal(['pattern_card', 'prompt', 'skill', 'threshold']);
    for (const entry of out.classified.slice(1)) {
      expect(entry.proposal_id).to.match(/^2026-09-18-/);
      expect(entry.destination).to.equal(entry.classification);
      expect(fs.existsSync(entry.proposal_path)).to.equal(true);
    }
    const stored = await readAll(dataDir);
    expect(stored.find((r) => r.feedback_id === '2bbbbbbbbbbb').proposal_id).to.equal(out.classified[1].proposal_id);
    const skill = proposals.find((p) => p.type === 'skill');
    expect(skill.body).to.include('Source: feedback 2bbbbbbbbbbb on item');
    expect(skill.body).to.not.include('U04AB12CD');
    expect(skill.evidence[0]).to.include({ feedback_id: '2bbbbbbbbbbb', item_id: ALPHA, up: 1, down: 2 });
  });

  it('accepts a valid projects.yaml fragment for a project annotation and downgrades a bad one to prose', async () => {
    const good = [
      'projects:', '  alpha.example.org:', '    notes: sentinel backlog normally under 200', '    thresholds:',
      '      pct_change_vs_previous_day: 80', '',
    ].join('\n');
    const bad = 'projects:\n  alpha.example.org:\n    password: hunter2\n';
    const engine = engineWith([
      answer('project_annotation', { projects_yaml: good }),
      answer('project_annotation', { projects_yaml: bad, title: 'Second annotation' }),
    ]);
    const out = await review([
      note('6ffffffffff1', 'baseline is 200 here'),
      note('7ffffffffff2', 'and again', { source_ts: '1758000072.000100' }),
    ], engine);
    const proposals = await readProposals(dataDir);
    expect(proposals).to.have.length(2);
    const accepted = proposals.find((p) => p.proposal_id === out.classified[0].proposal_id);
    expect(accepted.type).to.equal('project_annotation');
    expect(accepted.body).to.include('```yaml\nprojects:\n  [hostname]:');
    expect(accepted.body).to.include('pct_change_vs_previous_day: 80');
    expect(accepted.body).to.include('Rationale');
    expect(accepted.flags.some((f) => f.kind === 'hostname')).to.equal(true);
    const downgraded = proposals.find((p) => p.proposal_id === out.classified[1].proposal_id);
    expect(downgraded.body).to.not.include('```yaml');
    expect(downgraded.body).to.include('fragment rejected:');
    expect(downgraded.body).to.include('password');
    expect(validateProjectsFragment(good).ok).to.equal(true);
    expect(validateProjectsFragment(bad)).to.include({ ok: false });
    expect(validateProjectsFragment('not: projects').ok).to.equal(false);
    expect(validateProjectsFragment(': : :').ok).to.equal(false);
  });

  it('leaves a note unclassified when the model fails, returns bad output or exceeds the schema', async () => {
    const engine = {
      singleTurn: sinon.stub()
        .onFirstCall().rejects(new Error('boom'))
        .onSecondCall().resolves({
          ...answer('none'), result: { ...answer('none').result, subtype: 'error_max_budget_usd' },
        })
        .onThirdCall().resolves({ ...answer('none'), structuredOutput: { classification: 'made-up' } }),
    };
    const out = await review([
      note('8aaaaaaaaaaa', 'one', { source_ts: '1758000081.000100' }),
      note('9bbbbbbbbbbb', 'two', { source_ts: '1758000082.000100' }),
      note('0cccccccccccc'.slice(0, 12), 'three', { source_ts: '1758000083.000100' }),
    ], engine);
    expect(out.classified).to.deep.equal([]);
    expect(out.unclassified.sort()).to.deep.equal(['0ccccccccccc', '8aaaaaaaaaaa', '9bbbbbbbbbbb']);
    expect((await readAll(dataDir)).every((r) => r.classification === null)).to.equal(true);
    expect(quiet.warns.filter((w) => w.event === 'feedback.review_failed')).to.have.length(3);
    expect(out.calls).to.have.length(2);
  });

  it('describes an unmatched note as having no matched item', async () => {
    const engine = engineWith([answer('none')]);
    await review([note('1bbbbbbbbbbb', 'general remark', { target: 'brief', item_id: null, matched: false })], engine);
    expect(engine.singleTurn.firstCall.args[0].userPrompt).to.include('no matched item');
  });
});

describe('feedback/review: lessons are required only where a proposal is written', () => {
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
  });
  afterEach(() => removeDir(dataDir));

  const review = (records, engine) => reviewFeedback({
    dataDir, runId: '2026-09-18', date: '2026-09-18', records, byItem, engine, config, promptText: PROMPT,
    logger: quiet,
  });

  it('classifies a note as none or expectation even when the lesson is empty', async () => {
    await appendRecords(dataDir, [
      note('1a1a1a1a1a1a', 'thanks, that was useful'), note('2b2b2b2b2b2b', 'expected until 1 October'),
    ]);
    const records = await readAll(dataDir);
    const engine = engineWith([
      answer('none', { title: 'Thanks', lesson: '', rationale: '' }),
      answer('expectation', { title: 'Horizon', lesson: '', rationale: 'stated horizon' }),
    ]);
    const result = await review(records, engine);
    expect(result.unclassified).to.deep.equal([]);
    expect(result.classified.map((c) => c.classification)).to.deep.equal(['none', 'expectation']);
    expect(result.classified.every((c) => c.proposal_id === null)).to.equal(true);
    expect((await readAll(dataDir)).map((r) => r.classification)).to.deep.equal(['none', 'expectation']);
    expect(await readProposals(dataDir)).to.deep.equal([]);
  });

  it('leaves a note unclassified when a proposal-producing classification comes with an empty lesson', async () => {
    await appendRecords(dataDir, [note('3c3c3c3c3c3c', 'a rise after an upgrade means a transition is throwing')]);
    const records = await readAll(dataDir);
    quiet.warns.length = 0;
    const result = await review(records, engineWith([answer('skill', { lesson: '   ' })]));
    expect(result.classified).to.deep.equal([]);
    expect(result.unclassified).to.deep.equal(['3c3c3c3c3c3c']);
    expect(quiet.warns.some((w) => w.event === 'feedback.review_failed' && /empty lesson for a skill/.test(w.reason)))
      .to.equal(true);
    expect((await readAll(dataDir))[0].classification).to.equal(null);
    expect(await readProposals(dataDir)).to.deep.equal([]);
  });

  it('masks Slack mentions and ids inside the note before it reaches the model', async () => {
    await appendRecords(dataDir, [note('4d4d4d4d4d4d', 'ask <@U0123ABCD> or U0999ZZZ9 about the wording')]);
    const engine = engineWith([answer('prompt')]);
    await review(await readAll(dataDir), engine);
    const prompt = engine.singleTurn.firstCall.args[0].userPrompt;
    expect(prompt).to.include('ask [person] or [person] about the wording');
    expect(prompt).to.not.match(/U0123ABCD|U0999ZZZ9|<@/);
  });
});
