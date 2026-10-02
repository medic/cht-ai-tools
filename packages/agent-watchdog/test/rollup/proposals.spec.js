const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeProposals, readProposals, slugify, parseProposalFile, TYPES } = require('../../src/rollup/proposals');
const { applyMemoryUpdate } = require('../../src/rollup/memory');
const { RunDir, ensureDataLayout } = require('../../src/store/run-dir');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { tempDir, removeDir } = require('../helpers/fixtures');

const NOW = () => new Date('2026-09-18T06:30:00Z');

const treeHash = (dirs) => {
  const hash = crypto.createHash('sha256');
  const visit = (dir) => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else {
        hash.update(full).update(fs.readFileSync(full));
      }
    }
  };
  dirs.forEach(visit);
  return hash.digest('hex');
};

describe('rollup/proposals (FR-032, FR-033)', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    runDir = await RunDir.create(dataDir, '2026-09-18');
  });
  afterEach(() => removeDir(dataDir));

  const write = (proposals, extra = {}) => writeProposals({
    dataDir, runDir, runId: '2026-09-18', date: '2026-09-18', proposals, now: NOW, ...extra,
  });
  const readFile = (rel) => fs.readFileSync(path.join(dataDir, rel), 'utf8');

  it('writes <date>-<type>-<slug>.md per type with front matter, plus a copy in the run directory', async () => {
    const result = await write([
      { type: 'skill', title: 'Sentinel backlog climbs before month end', body: 'Pattern: backlog rises for hours.' },
      { type: 'prompt', title: 'Ask for the trend shape', body: 'Add a line about shape.' },
      {
        type: 'threshold',
        title: 'Raise the percentage threshold',
        body: 'Body.',
        evidence: [{ current: 50, proposed: 80 }],
      },
      { type: 'pattern_card', title: 'Stuck transitions', body: 'Symptom and resolution.' },
    ]);
    expect(result.written.map((w) => w.proposal_id)).to.deep.equal([
      '2026-09-18-skill-sentinel-backlog-climbs-before-month-end',
      '2026-09-18-prompt-ask-for-the-trend-shape',
      '2026-09-18-threshold-raise-the-percentage-threshold',
      '2026-09-18-pattern_card-stuck-transitions',
    ]);
    expect(result.superseded).to.deep.equal([]);
    for (const w of result.written) {
      expect(fs.existsSync(path.join(dataDir, 'proposals', `${w.proposal_id}.md`)), w.proposal_id).to.equal(true);
      expect(fs.existsSync(runDir.path('proposals', `${w.proposal_id}.md`)), w.proposal_id).to.equal(true);
      expect(readFile(`proposals/${w.proposal_id}.md`)).to.equal(fs.readFileSync(w.run_path, 'utf8'));
    }
    const text = readFile('proposals/2026-09-18-threshold-raise-the-percentage-threshold.md');
    const { frontMatter, body } = parseProposalFile(text);
    expect(frontMatter).to.deep.equal({
      proposal_id: '2026-09-18-threshold-raise-the-percentage-threshold',
      type: 'threshold',
      run_id: '2026-09-18',
      title: 'Raise the percentage threshold',
      status: 'proposed',
      created_at: '2026-09-18T06:30:00.000Z',
      flags: [],
      evidence: [{ current: 50, proposed: 80 }],
    });
    expect(body).to.equal('Body.');
    expect(text.startsWith('---\n')).to.equal(true);
  });

  it('keeps the pattern-level body but masks identifiers and lists them under flags with their kinds', async () => {
    const body = [
      'On alpha.example.org the sentinel backlog climbed for seven hours; <@U0123ABCD> confirmed it and',
      'Jane Doe asked ops@example.org to watch it. Token xoxb-111-222 must never appear.',
      'Pattern: a monotonic rise over more than six hours precedes a stuck transition.',
    ].join('\n');
    const result = await write(
      [{ type: 'skill', title: 'Backlog climb on alpha.example.org', body }],
      { hosts: ['alpha.example.org'], persons: ['Jane Doe'] },
    );
    const [written] = result.written;
    expect(written.proposal_id).to.equal('2026-09-18-skill-backlog-climb-on-hostname');
    const text = readFile(`proposals/${written.proposal_id}.md`);
    const { frontMatter, body: stored } = parseProposalFile(text);
    expect(frontMatter.title).to.equal('Backlog climb on [hostname]');
    expect(stored).to.include('On [hostname] the sentinel backlog climbed');
    expect(stored).to.include('[person] confirmed it and\n[person] asked [address] to watch it. Token [secret]');
    expect(stored).to.include('Pattern: a monotonic rise over more than six hours precedes a stuck transition.');
    expect(text).to.not.include('xoxb');
    expect(stored).to.not.include('alpha.example.org');
    expect(frontMatter.flags).to.deep.equal([
      { kind: 'hostname', excerpt: 'alpha.example.org' },
      { kind: 'person', excerpt: 'U0123ABCD' },
      { kind: 'person', excerpt: 'Jane Doe' },
      { kind: 'address', excerpt: 'o***@example.org' },
      { kind: 'secret', excerpt: 'slack_token' },
    ]);
    expect(written.flags).to.deep.equal(frontMatter.flags);
  });

  it('suffixes a same-day collision and supersedes an earlier proposal with the same type and slug', async () => {
    const earlierRun = await RunDir.create(dataDir, '2026-09-17');
    const earlier = await writeProposals({
      dataDir, runDir: earlierRun, runId: '2026-09-17', date: '2026-09-17', now: NOW,
      proposals: [{ type: 'skill', title: 'Backlog climb', body: 'first version' }],
    });
    expect(earlier.written[0].proposal_id).to.equal('2026-09-17-skill-backlog-climb');

    const later = await write([
      { type: 'skill', title: 'Backlog climb', body: 'second version' },
      { type: 'skill', title: 'Backlog climb', body: 'same day duplicate' },
      { type: 'prompt', title: 'Backlog climb', body: 'different type, untouched' },
    ]);
    expect(later.written.map((w) => w.proposal_id)).to.deep.equal([
      '2026-09-18-skill-backlog-climb', '2026-09-18-skill-backlog-climb-2', '2026-09-18-prompt-backlog-climb',
    ]);
    expect(later.superseded).to.deep.equal(['2026-09-17-skill-backlog-climb']);
    const old = parseProposalFile(readFile('proposals/2026-09-17-skill-backlog-climb.md'));
    expect(old.frontMatter).to.include({ status: 'superseded', superseded_by: '2026-09-18-skill-backlog-climb' });
    expect(old.body).to.equal('first version');
    const all = await readProposals(dataDir);
    expect(all.map((p) => [p.proposal_id, p.status])).to.deep.equal([
      ['2026-09-17-skill-backlog-climb', 'superseded'],
      ['2026-09-18-prompt-backlog-climb', 'proposed'],
      ['2026-09-18-skill-backlog-climb', 'proposed'],
      ['2026-09-18-skill-backlog-climb-2', 'proposed'],
    ]);
    expect(all[0].body).to.equal('first version');
    expect(all[0].path).to.equal(path.join(dataDir, 'proposals', '2026-09-17-skill-backlog-climb.md'));
  });

  it('accepts project_annotation as a fifth destination (FR-061)', async () => {
    expect(TYPES).to.include('project_annotation');
    const { written } = await writeProposals({
      dataDir, runDir, runId: '2026-09-18', date: '2026-09-18', now: NOW,
      proposals: [{
        type: 'project_annotation', title: 'Annotate the sentinel baseline',
        body: [
          'On one project the sentinel backlog is normally under 200.', '', '```yaml', 'projects:',
          '  alpha.example.org:', '    notes: sentinel backlog normally under 200', '```', '',
        ].join('\n'),
        evidence: [{ feedback_id: 'abcdefabcdef' }],
      }],
    });
    expect(written[0].type).to.equal('project_annotation');
    const [stored] = await readProposals(dataDir);
    expect(stored.type).to.equal('project_annotation');
    expect(stored.body).to.include('[hostname]');
    expect(stored.flags.map((f) => f.kind)).to.include('hostname');
  });

  it('skips a proposal with an unknown type, logging a warning instead of throwing', async () => {
    const warnings = [];
    const logger = { warn: (event, fields) => warnings.push({ event, ...fields }), info() {}, debug() {}, error() {} };
    const result = await write([
      { type: 'calendar', title: 'Not a proposal type', body: 'x' },
      { type: 'skill', title: 'Fine', body: 'y' },
    ], { logger });
    expect(result.written.map((w) => w.type)).to.deep.equal(['skill']);
    expect(warnings[0].event).to.equal('proposals.skipped');
    expect(warnings[0].type).to.equal('calendar');
  });

  it('slugifies titles into short lowercase identifiers', () => {
    expect(slugify('Sentinel backlog climbs before month end!')).to.equal('sentinel-backlog-climbs-before-month-end');
    expect(slugify('  [hostname] --- odd   spacing ')).to.equal('hostname-odd-spacing');
    expect(slugify('')).to.equal('proposal');
    expect(slugify('x'.repeat(100))).to.have.length(60);
  });

  it('flags identifiers found in the evidence without destroying it, and drops evidence holding a secret', async () => {
    const write = (proposals) => writeProposals({
      dataDir, runDir, runId: '2026-09-18', date: '2026-09-18', proposals, hosts: ['alpha.example.org'], now: NOW,
    });
    const evidence = [{
      project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count',
      current_threshold: 50, suggested_threshold: 80, effect_last_30d: { items_kept: 12, items_dropped: 6 },
    }];
    const { written } = await write([{
      type: 'threshold', title: 'Raise the percentage threshold', body: 'On one project the rule fires too often.',
      evidence,
    }]);
    expect(written[0].flags).to.deep.equal([{ kind: 'hostname', excerpt: 'alpha.example.org' }]);
    const [stored] = await readProposals(dataDir);
    expect(stored.evidence).to.deep.equal(evidence);
    expect(stored.body).to.equal('On one project the rule fires too often.');

    const logs = [];
    const logger = { info() {}, warn: (event, fields) => logs.push({ event, ...fields }) };
    const leaky = await writeProposals({
      dataDir, runDir, runId: '2026-09-18', date: '2026-09-18', now: NOW, logger,
      proposals: [{
        type: 'prompt', title: 'Mention the token', body: 'pattern-level text',
        evidence: [{ note: 'use xoxb-123-abc to read the channel', reviewer: 'U0123ABCD' }],
      }],
    });
    expect(leaky.written[0].flags.map((f) => f.kind).sort()).to.deep.equal(['person', 'secret']);
    const kept = (await readProposals(dataDir)).find((p) => p.type === 'prompt');
    expect(kept.evidence).to.deep.equal([]);
    expect(JSON.stringify(kept)).to.not.include('xoxb-123-abc');
    expect(logs.some((l) => l.event === 'proposals.evidence_dropped')).to.equal(true);
  });

  it('never writes to the prompts, skill, schema, agent or policy files (guard)', async () => {
    const guarded = [
      PACKAGE_PATHS.promptsDir, PACKAGE_PATHS.skillDir, PACKAGE_PATHS.schemaDir, PACKAGE_PATHS.agentDir,
      PACKAGE_PATHS.defaultsDir,
    ];
    const before = treeHash(guarded);
    await write([{ type: 'skill', title: 'Anything', body: 'Change the skill to mention month end.' }]);
    await applyMemoryUpdate({ dataDir, runDir, runId: '2026-09-18', replaceWith: 'x\n'.repeat(3000), maxTokens: 500 });
    expect(treeHash(guarded)).to.equal(before);
    const written = fs.readdirSync(path.join(dataDir, 'proposals'));
    expect(written).to.deep.equal(['2026-09-18-skill-anything.md']);
  });
});
