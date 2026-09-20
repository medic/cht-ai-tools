'use strict';
// The run directory and the data-volume layout (contracts/run-directory.md).
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const atomic = require('./atomic');

const TEMPFAIL = 75;
const USAGE = 64;
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}(-f\d+)?$/;
// A replay label names one directory level; nothing that could leave runs-replay/<run_id>/.
const REPLAY_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class RunExistsError extends Error {
  constructor(runId) {
    super(`a run for ${runId} already exists; pass --force to run again`);
    this.name = 'RunExistsError';
    this.code = TEMPFAIL;
    this.runId = runId;
  }
}

class ReplayExistsError extends Error {
  constructor(runId, label) {
    super(`a replay labelled "${label}" already exists for ${runId}; choose another --label`);
    this.name = 'ReplayExistsError';
    this.code = TEMPFAIL;
    this.runId = runId;
    this.label = label;
  }
}

class ReplayLabelError extends Error {
  constructor(label) {
    super(`invalid replay label "${label}": use letters, digits, dot, underscore or dash, not starting with a dot`);
    this.name = 'ReplayLabelError';
    this.code = USAGE;
    this.label = label;
  }
}

const dataPaths = (dataDir) => ({
  root: dataDir,
  runs: path.join(dataDir, 'runs'),
  replay: path.join(dataDir, 'runs-replay'),
  memory: path.join(dataDir, 'memory'),
  memoryFile: path.join(dataDir, 'memory', 'memory.md'),
  memoryHistory: path.join(dataDir, 'memory', 'history'),
  feedbackFile: path.join(dataDir, 'feedback.jsonl'),
  proposals: path.join(dataDir, 'proposals'),
  corpus: path.join(dataDir, 'corpus'),
  corpusIndex: path.join(dataDir, 'corpus', 'index.json'),
  corpusOutcomes: path.join(dataDir, 'corpus', 'outcomes'),
  corpusCardsProposed: path.join(dataDir, 'corpus', 'cards.proposed'),
  calibration: path.join(dataDir, 'calibration'),
  corpusRaw: path.join(dataDir, 'knowledge-corpus', 'raw'),
  alerts: path.join(dataDir, 'alerts'),
  alertEpisodesFile: path.join(dataDir, 'alerts', 'episodes.jsonl'),
});

const ensureDataLayout = async (dataDir) => {
  const p = dataPaths(dataDir);
  const dirs = [
    p.runs, p.replay, p.memory, p.memoryHistory, p.proposals, p.corpus, p.corpusOutcomes, p.corpusCardsProposed,
    p.calibration, p.alerts,
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
  return p;
};

class RunDir {
  /**
   * @param {string} dataDir the data volume
   * @param {string} runId the run (for a replay: the run being replayed)
   * @param {object} [options] `label` marks a replay directory under runs-replay/<runId>/<label>
   */
  constructor(dataDir, runId, { label = null } = {}) {
    this.dataDir = dataDir;
    this.runId = runId;
    this.kind = label === null ? 'run' : 'replay';
    this.label = label;
    this.replayOf = label === null ? null : runId;
    this.root = label === null ? path.join(dataDir, 'runs', runId) : RunDir.replayRoot(dataDir, runId, label);
    this._stageStarts = new Map();
  }

  static replayRoot(dataDir, runId, label) {
    return path.join(dataDir, 'runs-replay', runId, label);
  }

  /**
   * Create a replay directory with the run's layout (contracts/run-directory.md "Replay"). The label is one
   * directory level; a duplicate label is refused so two replays never share artefacts.
   */
  static async createReplay(dataDir, runId, label) {
    if (typeof label !== 'string' || !REPLAY_LABEL_PATTERN.test(label)) {
      throw new ReplayLabelError(label);
    }
    await fs.mkdir(path.join(dataDir, 'runs-replay', runId), { recursive: true });
    const replay = new RunDir(dataDir, runId, { label });
    try {
      await fs.mkdir(replay.root);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new ReplayExistsError(runId, label);
      }
      throw error;
    }
    return replay;
  }

  static openReplay(dataDir, runId, label) {
    const replay = new RunDir(dataDir, runId, { label });
    if (!fsSync.existsSync(replay.root)) {
      throw new Error(`replay ${runId}/${label} not found under ${dataDir}`);
    }
    return replay;
  }

  static async listReplays(dataDir, runId) {
    const dir = path.join(dataDir, 'runs-replay', runId);
    if (!fsSync.existsSync(dir)) {
      return [];
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  }

  /**
   * Create the run directory. The non-recursive mkdir is the lock against a duplicate or a concurrent
   * run for the same date (FR-042, FR-047).
   */
  static async create(dataDir, runId) {
    await fs.mkdir(path.join(dataDir, 'runs'), { recursive: true });
    const run = new RunDir(dataDir, runId);
    try {
      await fs.mkdir(run.root);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new RunExistsError(runId);
      }
      throw error;
    }
    return run;
  }

  static open(dataDir, runId) {
    const run = new RunDir(dataDir, runId);
    if (!fsSync.existsSync(run.root)) {
      throw new Error(`run ${runId} not found under ${dataDir}`);
    }
    return run;
  }

  static async list(dataDir) {
    const runs = path.join(dataDir, 'runs');
    if (!fsSync.existsSync(runs)) {
      return [];
    }
    const entries = await fs.readdir(runs, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && RUN_ID_PATTERN.test(e.name)).map((e) => e.name).sort();
  }

  static async nextForcedId(dataDir, date) {
    const ids = await RunDir.list(dataDir);
    const numbers = ids.filter((id) => id.startsWith(`${date}-f`)).map((id) => Number(id.slice(date.length + 2)));
    return `${date}-f${(numbers.length ? Math.max(...numbers) : 0) + 1}`;
  }

  path(...rel) {
    return path.join(this.root, ...rel); 
  }

  projectPath(slug, ...rel) {
    return path.join(this.root, slug, ...rel); 
  }

  exists(rel) {
    return fsSync.existsSync(this.path(rel)); 
  }

  readJson(rel) {
    return atomic.readJson(this.path(rel)); 
  }

  writeJson(rel, value) {
    return atomic.writeJsonAtomic(this.path(rel), value); 
  }

  writeGz(rel, value) {
    return atomic.writeGzipJsonAtomic(this.path(rel), value); 
  }

  readGz(rel) {
    return atomic.readGzipJson(this.path(rel)); 
  }

  writeText(rel, text) {
    return atomic.writeFileAtomic(this.path(rel), text); 
  }

  readText(rel) {
    return fs.readFile(this.path(rel), 'utf8'); 
  }

  appendJsonl(rel, value) {
    return atomic.appendJsonl(this.path(rel), value); 
  }

  readJsonl(rel) {
    return atomic.readJsonl(this.path(rel)); 
  }

  async readRun() {
    return this.exists('run.json') ? this.readJson('run.json') : {};
  }

  /** Merge a patch into run.json atomically; `stages` is replaced when given, other keys merge shallowly. */
  async updateRun(patch) {
    const current = await this.readRun();
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    await this.writeJson('run.json', next);
    return next;
  }

  async stageStart(name) {
    const startedAt = new Date().toISOString();
    this._stageStarts.set(name, { hr: process.hrtime.bigint(), startedAt });
    const run = await this.readRun();
    const stages = (run.stages || []).filter((s) => s.name !== name);
    stages.push({ name, status: 'running', started_at: startedAt, finished_at: null, duration_ms: null, error: null });
    return this.updateRun({ stages });
  }

  async stageEnd(name, status, extra = {}) {
    const start = this._stageStarts.get(name);
    const durationMs = start ? Number(process.hrtime.bigint() - start.hr) / 1e6 : null;
    const run = await this.readRun();
    const stages = (run.stages || []).map((s) => (s.name === name
      ? { ...s, status, finished_at: new Date().toISOString(), duration_ms: durationMs, ...extra }
      : s));
    if (!stages.some((s) => s.name === name)) {
      stages.push({
        name,
        status,
        started_at: start ? start.startedAt : null,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        error: null,
        ...extra,
      });
    }
    return this.updateRun({ stages });
  }
}

module.exports = {
  RunDir, RunExistsError, ReplayExistsError, ReplayLabelError, dataPaths, ensureDataLayout, RUN_ID_PATTERN,
  REPLAY_LABEL_PATTERN,
};
