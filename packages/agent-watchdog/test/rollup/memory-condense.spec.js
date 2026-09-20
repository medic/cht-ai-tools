const fs = require('node:fs');
const path = require('node:path');
const {
  applyMemoryUpdate, condenseByCode, maxCharsFor, createModelCondenser, estimateTokens, readMemory,
} = require('../../src/rollup/memory');
const { loadDefinition } = require('../../src/agent/definition');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { RunDir, ensureDataLayout } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

const MAX_TOKENS = 500;
const fits = (text) => Math.ceil(estimateTokens(text) * 1.1) <= MAX_TOKENS;
const config = {
  model: { name: 'claude-fable-5-1', effort: 'max' },
  bounds: { maxTurns: 5, maxBudgetUsdProject: 1, modelTimeoutMs: 1000 },
};
const lines = (n) => Array.from({ length: n }, (_, i) => `note ${String(i + 1).padStart(3, '0')}: something durable`);

describe('rollup/memory condensation (US4 scenario 2)', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    runDir = await RunDir.create(dataDir, '2026-09-18');
  });
  afterEach(() => removeDir(dataDir));

  const apply = (over) => applyMemoryUpdate({ dataDir, runDir, runId: '2026-09-18', maxTokens: MAX_TOKENS, ...over });
  const overCap = `${lines(120).join('\n')}\n`;

  it('condenses through the model when the update exceeds the cap and the result fits', async () => {
    expect(fits(overCap)).to.equal(false);
    const condense = sinon.stub().resolves('durable facts only\n');
    const result = await apply({ replaceWith: overCap, condense });
    expect(result).to.include({ applied: true, reason: 'condensed', condensed_by: 'model', version: 1 });
    expect(condense).to.have.been.calledOnceWith(overCap, { maxTokens: MAX_TOKENS, maxChars: maxCharsFor(MAX_TOKENS) });
    expect(fs.readFileSync(path.join(dataDir, 'memory', 'memory.md'), 'utf8')).to.equal('durable facts only\n');
    const history = fs.readFileSync(path.join(dataDir, 'memory', 'history', '2026-09-18.patch'), 'utf8');
    expect(history).to.include('+durable facts only');
    expect(fs.readFileSync(runDir.path('memory.patch'), 'utf8')).to.equal(history);
    expect((await readMemory(dataDir)).version).to.equal(1);
  });

  it('falls back to code condensation when the model result is still over the cap or the call throws', async () => {
    const warnings = [];
    const logger = { warn: (event, fields) => warnings.push({ event, ...fields }), info() {}, debug() {}, error() {} };
    const stillOver = await apply({ replaceWith: overCap, condense: sinon.stub().resolves(overCap) });
    expect(stillOver).to.include({ applied: true, reason: 'condensed', condensed_by: 'code', version: 1 });
    const memory = fs.readFileSync(path.join(dataDir, 'memory', 'memory.md'), 'utf8');
    expect(fits(memory)).to.equal(true);
    expect(memory.startsWith('<!-- condensed by code:')).to.equal(true);

    const runTwo = await RunDir.create(dataDir, '2026-09-19');
    const throwing = await apply({
      runDir: runTwo, runId: '2026-09-19', replaceWith: `${overCap}extra line\n`,
      condense: sinon.stub().rejects(new Error('model unavailable')), logger,
    });
    expect(throwing).to.include({ applied: true, reason: 'condensed', condensed_by: 'code', version: 2 });
    expect(warnings.some((w) => w.event === 'memory.condense_failed')).to.equal(true);
    expect(fs.existsSync(runTwo.path('memory.patch'))).to.equal(true);
  });

  it('condenses by code when no condenser is given and never throws', async () => {
    const result = await apply({ replaceWith: overCap });
    expect(result).to.include({ applied: true, reason: 'condensed', condensed_by: 'code' });
    expect(fits(fs.readFileSync(path.join(dataDir, 'memory', 'memory.md'), 'utf8'))).to.equal(true);
  });

  it('applies an update within the cap unchanged, with condensed_by null', async () => {
    const result = await apply({ replaceWith: 'short\n' });
    expect(result).to.include({ applied: true, reason: 'applied', condensed_by: null });
  });

  it('condenseByCode keeps whole lines from the end under the cap and says how many it dropped', () => {
    const condensed = condenseByCode(overCap, MAX_TOKENS);
    expect(fits(condensed)).to.equal(true);
    const [note, ...kept] = condensed.replace(/\n$/, '').split('\n');
    const match = /^<!-- condensed by code: (\d+) lines dropped -->$/.exec(note);
    expect(match, note).to.not.equal(null);
    const dropped = Number(match[1]);
    expect(dropped + kept.length).to.equal(120);
    expect(kept).to.deep.equal(lines(120).slice(dropped));
    expect(kept.length).to.be.greaterThan(10);
    // one more line would not have fitted
    const oneMoreNote = note.replace(String(dropped), String(dropped - 1));
    const oneMore = `${oneMoreNote}\n${lines(120).slice(dropped - 1).join('\n')}\n`;
    expect(fits(oneMore)).to.equal(false);
    expect(maxCharsFor(MAX_TOKENS)).to.equal(Math.floor((MAX_TOKENS * 4) / 1.1));
  });

  describe('createModelCondenser', () => {
    const definition = loadDefinition({ paths: PACKAGE_PATHS, env: { AGENT_WATCHDOG_DOCS_MCP_URL: 'https://d/mcp' } });
    const turn = (structuredOutput) => ({
      structuredOutput,
      result: {
        subtype: 'success',
        usage: { input_tokens: 200, output_tokens: 50, cache_read_tokens: 10, cache_creation_tokens: 0 },
        total_cost_usd: 0.004, num_turns: 1, duration_ms: 90, session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    });

    it('builds the prompt from the rollup.md section, wraps the memory as untrusted and records a cost', async () => {
      const engine = { singleTurn: sinon.stub().resolves(turn({ memory: 'short memory\n' })) };
      const calls = [];
      const condense = createModelCondenser({ engine, definition, config, calls, runId: '2026-09-18' });
      const out = await condense('long memory text', { maxTokens: MAX_TOKENS, maxChars: maxCharsFor(MAX_TOKENS) });
      expect(out).to.equal('short memory\n');
      const request = engine.singleTurn.firstCall.args[0];
      expect(request.systemPrompt[0]).to.include(String(MAX_TOKENS)).and.include(String(maxCharsFor(MAX_TOKENS)));
      expect(request.systemPrompt[0]).to.not.include('{{');
      expect(request.userPrompt).to.include('<untrusted source="memory">').and.include('long memory text');
      expect(request.outputSchema.properties.memory.type).to.equal('string');
      expect(request.outputSchema.required).to.deep.equal(['memory']);
      expect(request).to.include({ model: 'claude-fable-5-1', effort: 'max', name: 'memory-condense' });
      expect(request.bounds).to.deep.equal({ maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 1000 });
      expect(calls).to.have.length(1);
      expect(calls[0]).to.include({
        run_id: '2026-09-18', stage: 'rollup', pass: null, project_url: null, model: 'claude-fable-5-1',
        cost_usd: 0.004, input_tokens: 200, output_tokens: 50, cache_read_tokens: 10,
      });
    });

    it('returns null when the output carries no memory string', async () => {
      const engine = { singleTurn: sinon.stub().resolves(turn({ headline: 'not a memory' })) };
      const condense = createModelCondenser({ engine, definition, config });
      expect(await condense('x', { maxTokens: MAX_TOKENS, maxChars: 10 })).to.equal(null);
    });

    it('throws a clear error when the roll-up prompt has no condensation section', () => {
      expect(() => createModelCondenser({ engine: {}, definition: { rollup: '# nothing here' }, config }))
        .to.throw(/Memory condensation/);
    });
  });
});
