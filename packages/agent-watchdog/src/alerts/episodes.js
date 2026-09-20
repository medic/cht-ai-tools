'use strict';
// Alert Episodes (FR-067): the durable, append-only record of each firing instance from start to clear as events
// (opened, observed, cleared) in alerts/episodes.jsonl, with correlations computed by code (the expected-load
// window active at the start, a CHT version change across it, related candidates and items) and the explanation
// copied from a gate-accepted item on the same project and category. A cleared episode also reaches the corpus.
const crypto = require('node:crypto');
const atomic = require('../store/atomic');
const { dataPaths } = require('../store/run-dir');
const { schemas } = require('../model/schemas');
const { activeWindow } = require('../analyze/calendar');
const { appendAlertEpisodes } = require('../corpus/outcomes');

const EPISODES_FILE = 'alerts/episodes.jsonl';
const noop = { debug() {}, info() {}, warn() {}, error() {} };

const hash12 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

/** Identity: the instance and the date it started firing. */
const episodeId = (instanceId, startedAt) => hash12(`${instanceId}|${String(startedAt).slice(0, 10)}`);

const readEpisodeEvents = (dataDir) => atomic.readJsonl(dataPaths(dataDir).alertEpisodesFile);

/** Episodes opened and not yet cleared, by instance id. */
const openEpisodes = (events) => {
  const open = new Map();
  for (const event of events || []) {
    if (event.event === 'opened') {
      open.set(event.instance_id, event);
    } else if (event.event === 'cleared') {
      open.delete(event.instance_id);
    }
  }
  return open;
};

/** A metric key is related to a category when it contains one of the category's metric names (alerts.yaml). */
const metricRelated = (metric, names) => (names || []).some((name) => String(metric || '').includes(name));

/**
 * Correlations by code, plus the explanation an accepted item gives when one exists (data-model.md Alert Episode).
 * `observedAt` is the run start, stamped on a version change.
 */
const correlationsFor = ({
  instance, project = null, previousProject = null, candidates = [], items = [], categories = {}, observedAt,
}) => {
  const names = categories[instance.category] || [];
  const startedAt = new Date(instance.started_at);
  const window = project ? activeWindow([], project, startedAt) : null;
  const sameProject = (record) => record.project_url === instance.project_url;
  const relatedCandidates = candidates
    .filter((c) => sameProject(c) && metricRelated(c.metric, names))
    .map((c) => c.candidate_id);
  const related = items.filter((item) => sameProject(item) && metricRelated(item.metric, names));
  let versionChange = null;
  if (project && previousProject && project.cht_version && previousProject.cht_version
    && project.cht_version !== previousProject.cht_version) {
    versionChange = { from: previousProject.cht_version, to: project.cht_version, observed: observedAt };
  }
  return {
    expected_load_window_id: window ? window.id : null,
    version_change: versionChange,
    related_candidates: relatedCandidates,
    related_items: related.map((item) => item.item_id),
    explanation: related.length ? { item_id: related[0].item_id, why_now: related[0].why_now } : null,
  };
};

const hoursBetween = (from, to) => Math.round(((to - Date.parse(from)) / 3600000) * 100) / 100;

/**
 * Append this run's episode events. Firing instances open or observe an episode; open episodes whose instance no
 * longer fires are cleared and appended to the corpus outcomes. Callers skip this when the alerting API was
 * unavailable, since an absent instance then means nothing. Times are the observation time (when the alerts were
 * read), else the run start; a duration is never negative: clock skew between the source and this host is
 * recorded as zero and logged (revision 16).
 * @returns {Promise<{ opened: object[], observed: object[], cleared: object[] }>}
 */
const updateEpisodes = async ({
  dataDir, runId, date, runStart, observedAt = null, classified, items = [], candidatesByProject = {},
  discovery = null, previousDiscovery = null, categories = {}, logger = noop,
}) => {
  const start = new Date(observedAt || runStart);
  const at = start.toISOString();
  const events = await readEpisodeEvents(dataDir);
  const open = openEpisodes(events);
  const projects = new Map(((discovery && discovery.projects) || []).map((p) => [p.url, p]));
  const previousProjects = new Map(((previousDiscovery && previousDiscovery.projects) || []).map((p) => [p.url, p]));
  const firing = ((classified && classified.instances) || []).filter((i) => i.state === 'firing');
  const opened = [];
  const observed = [];
  const cleared = [];

  for (const instance of firing) {
    const project = projects.get(instance.project_url) || null;
    const { explanation, ...correlations } = correlationsFor({
      instance, project, previousProject: previousProjects.get(instance.project_url) || null,
      candidates: candidatesByProject[instance.project_url] || [], items, categories, observedAt: at,
    });
    const existing = open.get(instance.instance_id);
    const record = {
      episode_id: existing ? existing.episode_id : episodeId(instance.instance_id, instance.started_at),
      run_id: runId,
      at,
      instance_id: instance.instance_id,
      rule_uid: instance.rule_uid,
      title: instance.title,
      host: instance.host,
      project_url: instance.project_url,
      group: instance.group,
      category: instance.category,
      importance: instance.importance,
      started_at: existing ? existing.started_at : instance.started_at,
      cleared_at: null,
      duration_hours: null,
      correlations,
      explanation,
    };
    (existing ? observed : opened).push({ event: existing ? 'observed' : 'opened', ...record });
  }

  const firingIds = new Set(firing.map((i) => i.instance_id));
  for (const [instanceId, episode] of open) {
    if (firingIds.has(instanceId)) {
      continue;
    }
    const hours = hoursBetween(episode.started_at, start.getTime());
    if (hours < 0) {
      logger.warn('alerts.episode_duration_clamped', {
        instance_id: instanceId, started_at: episode.started_at, at, hours,
      });
    }
    cleared.push({
      ...episode,
      event: 'cleared',
      run_id: runId,
      at,
      cleared_at: at,
      duration_hours: Math.max(0, hours),
    });
  }

  const file = dataPaths(dataDir).alertEpisodesFile;
  for (const event of [...opened, ...observed, ...cleared]) {
    await atomic.appendJsonl(file, schemas.AlertEpisode.parse(event));
  }
  if (cleared.length) {
    await appendAlertEpisodes({ dataDir, date, runId, episodes: cleared });
  }
  logger.info('alerts.episodes', { opened: opened.length, observed: observed.length, cleared: cleared.length });
  return { opened, observed, cleared };
};

module.exports = {
  episodeId, readEpisodeEvents, openEpisodes, correlationsFor, updateEpisodes, metricRelated, EPISODES_FILE,
};
