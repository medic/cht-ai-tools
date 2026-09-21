'use strict';
// Read reactions and notes from the previous runs' posts (FR-026 to FR-029; contracts/slack-payload.md).
const path = require('node:path');
const { RunDir, dataPaths } = require('../store/run-dir');
const { schemas } = require('../model/schemas');
const identity = require('../model/identity');
const { appendRecords, readAll } = require('./store');
const { matchNote, matchAlertNote, noteVerdict } = require('./match');
const { parseNoteWithModel } = require('./parse-notes');

const BRIEF_EVENT = 'agent_watchdog.brief';
const ITEM_EVENT = 'agent_watchdog.item';
const ALERTS_EVENT = 'agent_watchdog.alerts';
const VERDICTS = { '+1': 'up', thumbsup: 'up', '-1': 'down', thumbsdown: 'down' };
const DAY_SECONDS = 86400;
const DAY_MS = 86400000;
const DEFAULT_INFLUENCE_DAYS = 30;

const noop = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const isBefore = (a, b) => {
  const pa = identity.parseRunId(a);
  const pb = identity.parseRunId(b);
  return pa.date < pb.date || (pa.date === pb.date && pa.force < pb.force);
};

/** Earlier runs to read: on or after `since` when given, otherwise the last `lookbackRuns`. */
const previousRuns = async (dataDir, runId, { since, lookbackRuns }) => {
  const ids = (await RunDir.list(dataDir)).filter((id) => isBefore(id, runId));
  if (since) {
    return ids.filter((id) => identity.parseRunId(id).date >= since);
  }
  return ids.slice(Math.max(0, ids.length - lookbackRuns));
};

const metadataOf = (message) => (message && message.metadata && message.metadata.event_type ? message.metadata : null);

const isBotMessage = (message) => Boolean(metadataOf(message) || message.bot_id || message.app_id);

const isNote = (message) => Boolean(message.user) && !isBotMessage(message) && typeof message.text === 'string';

const pageReplies = async (client, channel, ts, pace) => {
  const messages = [];
  let cursor;
  do {
    await pace();
    const page = await client.conversations.replies({
      channel, ts, limit: 1000, include_all_metadata: true, ...(cursor ? { cursor } : {}),
    });
    messages.push(...(page.messages || []));
    cursor = page.response_metadata && page.response_metadata.next_cursor ? page.response_metadata.next_cursor : null;
  } while (cursor);
  return messages;
};

/** Fallback for a run without publication.json: find its brief in that day's history by metadata. */
const findParentInHistory = async (client, channel, run, pace) => {
  const start = Date.parse(`${run.date}T00:00:00Z`) / 1000;
  let cursor;
  do {
    await pace();
    const page = await client.conversations.history({
      channel, oldest: String(start), latest: String(start + DAY_SECONDS), limit: 200, include_all_metadata: true,
      ...(cursor ? { cursor } : {}),
    });
    const hit = (page.messages || []).find((m) => {
      const meta = metadataOf(m);
      return meta && meta.event_type === BRIEF_EVENT && meta.event_payload && meta.event_payload.run_id === run.runId;
    });
    if (hit) {
      return hit.ts;
    }
    cursor = page.response_metadata && page.response_metadata.next_cursor ? page.response_metadata.next_cursor : null;
  } while (cursor);
  return null;
};

const reactionsOf = async (client, channel, ts, pace) => {
  await pace();
  const result = await client.reactions.get({ channel, timestamp: ts, full: true });
  return (result && result.message && result.message.reactions) || [];
};

const evidenceValue = (item) => {
  const current = (item.evidence || []).find((e) => e.window === 'current');
  return current ? current.value : null;
};

const emptyCounts = (meta = {}) => ({
  project_url: meta.project_url || null,
  metric: meta.metric || null,
  pattern_card: meta.pattern_card === undefined ? null : meta.pattern_card,
  up: 0,
  down: 0,
  retracted: 0,
  notes: [],
  verdict: 'unreviewed',
  horizon: null,
});

/** Tallies count a record only inside the influence window (FR-060); horizons are tracked separately. */
const applyRecord = (counts, record) => {
  if (record.kind === 'reaction') {
    if (record.verdict === 'retracted') {
      counts.retracted += 1;
      const original = /^retracted: (up|down)$/.exec(record.note || '');
      if (original) {
        counts[original[1]] -= 1;
      }
    } else if (record.verdict === 'up' || record.verdict === 'down') {
      counts[record.verdict] += 1;
    }
  } else if (record.kind === 'note') {
    if (record.note) {
      counts.notes.push(record.note);
    }
    // A thumbs written in a note is its verdict (FR-027, revision 23), counted on the item it cites and nowhere else.
    if (record.target === 'item' && record.matched && (record.verdict === 'up' || record.verdict === 'down')) {
      counts[record.verdict] += 1;
    }
  }
};

/** A horizon stated in any stored note holds until its date, whatever the window (FR-060). */
const applyHorizon = (counts, record, observedDate) => {
  if (record.kind === 'note' && record.horizon && record.horizon >= observedDate
    && (!counts.horizon || record.horizon > counts.horizon)) {
    counts.horizon = record.horizon;
  }
};

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The first date whose records still adjust ranking: `influenceDays` before the run date, inclusive. */
const windowStartFor = (observedDate, influenceDays) => (
  isoDate(Date.parse(`${observedDate}T00:00:00Z`) - influenceDays * DAY_MS)
);

/** Item identity for a stored record: today's index, else the source run's ranked items (best effort). */
const createMetaLookup = (dataDir, itemMeta) => {
  const cache = new Map();
  return async (record) => {
    if (itemMeta.has(record.item_id)) {
      return itemMeta.get(record.item_id);
    }
    if (!record.run_id || !cache.has(record.run_id)) {
      let items = [];
      try {
        const run = RunDir.open(dataDir, record.run_id);
        items = run.exists('rollup/items.ranked.json') ? await run.readJson('rollup/items.ranked.json') : [];
      } catch {
        items = [];
      }
      cache.set(record.run_id, new Map(items.map((item) => [item.item_id, item])));
    }
    const item = cache.get(record.run_id).get(record.item_id);
    return item ? { project_url: item.project_url, metric: item.metric, pattern_card: item.pattern_card } : {};
  };
};

const verdictOf = (counts) => {
  const up = Math.max(0, counts.up);
  const down = Math.max(0, counts.down);
  if (up > 0 && down === 0) {
    return 'confirmed';
  }
  if (down > 0 && up === 0) {
    return 'dismissed';
  }
  return up > 0 && down > 0 ? 'contested' : 'unreviewed';
};

/**
 * Ingest feedback from the previous runs' posts and update feedback.jsonl.
 * @returns the ingested document written to feedback.ingested.json (shape in the stage contract).
 */
const ingestFeedback = async ({
  client, channel, dataDir, runId, date, lookbackRuns = 7, since = null, engine = null, model, definition = null,
  logger = noop, pace = async () => {}, now = () => new Date(), influenceDays = DEFAULT_INFLUENCE_DAYS,
}) => {
  const observedDate = date || now().toISOString().slice(0, 10);
  const windowStart = windowStartFor(observedDate, influenceDays);
  const previous = await readAll(dataDir);
  const existingIds = new Set(previous.map((r) => r.feedback_id));
  const itemMeta = new Map();
  const candidates = [];
  const horizons = [];
  const sources = [];

  const runIds = await previousRuns(dataDir, runId, { since, lookbackRuns });
  for (const sourceId of runIds) {
    const run = RunDir.open(dataDir, sourceId);
    const runDate = identity.parseRunId(sourceId).date;
    const sourceRun = { runId: sourceId, date: runDate };
    let parentTs = null;
    let replyIndex = new Map();
    let fallback = false;
    if (run.exists('rollup/publication.json')) {
      const publication = await run.readJson('rollup/publication.json');
      parentTs = publication.ts;
      replyIndex = new Map((publication.replies || [])
        .map((r) => [r.ts, { item_id: r.item_id || null, alert_key: r.alert_key || null }]));
    } else {
      fallback = true;
      parentTs = await findParentInHistory(client, channel, sourceRun, pace);
      logger.info('feedback.fallback', { run_id: sourceId, found: Boolean(parentTs) });
    }
    if (!parentTs) {
      sources.push({ run_id: sourceId, parent_ts: null, replies: 0, notes: 0, fallback });
      continue;
    }

    const items = run.exists('rollup/items.ranked.json') ? await run.readJson('rollup/items.ranked.json') : [];
    for (const item of items) {
      itemMeta.set(item.item_id, {
        project_url: item.project_url, metric: item.metric, pattern_card: item.pattern_card, item,
      });
    }

    const messages = await pageReplies(client, channel, parentTs, pace);
    const itemReplies = [];
    const alertReplies = [];
    const notes = [];
    const alertReply = (ts, alertKey) => {
      const [group, ...rest] = String(alertKey).split('/');
      alertReplies.push({ ts, alert_key: alertKey, group, category: rest.join('/') });
    };
    for (const message of messages) {
      if (message.ts === parentTs) {
        continue;
      }
      const meta = metadataOf(message);
      if (meta && meta.event_type === ITEM_EVENT && meta.event_payload && meta.event_payload.item_id) {
        const payload = meta.event_payload;
        itemReplies.push({ ts: message.ts, item_id: payload.item_id });
        if (!itemMeta.has(payload.item_id)) {
          itemMeta.set(payload.item_id, {
            project_url: payload.project_url || null, metric: payload.metric || null, pattern_card: null,
          });
        }
      } else if (meta && meta.event_type === ALERTS_EVENT && meta.event_payload && meta.event_payload.group) {
        alertReply(message.ts, `${meta.event_payload.group}/${meta.event_payload.category}`);
      } else if (replyIndex.has(message.ts)) {
        const entry = replyIndex.get(message.ts);
        if (entry.item_id) {
          itemReplies.push({ ts: message.ts, item_id: entry.item_id });
        } else if (entry.alert_key) {
          alertReply(message.ts, entry.alert_key);
        }
      } else if (isNote(message)) {
        notes.push(message);
      }
    }

    const targets = [
      { ts: parentTs, target: 'brief', item_id: null, alert_key: null },
      ...itemReplies.map((r) => ({ ts: r.ts, target: 'item', item_id: r.item_id, alert_key: null })),
      // Reactions on an alert-group reply (FR-066): recorded and acknowledged, never a ranking input.
      ...alertReplies.map((r) => ({ ts: r.ts, target: 'alert_group', item_id: null, alert_key: r.alert_key })),
    ];
    for (const target of targets) {
      const reactions = await reactionsOf(client, channel, target.ts, pace);
      const present = new Set();
      for (const reaction of reactions) {
        const verdict = VERDICTS[reaction.name];
        if (!verdict) {
          continue;
        }
        for (const author of reaction.users || []) {
          present.add(`${author}|${verdict}`);
          candidates.push({
            feedback_id: identity.feedbackId(target.ts, author, 'reaction', verdict),
            date: observedDate, run_id: sourceId, target: target.target, item_id: target.item_id,
            alert_key: target.alert_key || null,
            kind: 'reaction', verdict, note: null, horizon: null, author, matched: true, source_ts: target.ts,
          });
        }
      }
      for (const record of previous) {
        const isLive = record.kind === 'reaction' && record.source_ts === target.ts
          && (record.verdict === 'up' || record.verdict === 'down');
        if (isLive && !present.has(`${record.author}|${record.verdict}`)) {
          candidates.push({
            feedback_id: identity.feedbackId(target.ts, record.author, 'reaction', 'retracted'),
            date: observedDate, run_id: record.run_id, target: record.target, item_id: record.item_id,
            alert_key: record.alert_key || null,
            kind: 'reaction', verdict: 'retracted', note: `retracted: ${record.verdict}`, horizon: null,
            author: record.author, matched: true, source_ts: target.ts,
          });
        }
      }
    }

    const knownItems = items.length
      ? items
      : itemReplies.map((r) => ({ item_id: r.item_id, ...(itemMeta.get(r.item_id) || {}) }));
    for (const message of notes) {
      const feedbackId = identity.feedbackId(message.ts, message.user, 'note', null);
      const stored = existingIds.has(feedbackId) ? previous.find((r) => r.feedback_id === feedbackId) : null;
      if (stored) {
        // A note already on record keeps the horizon fixed when it was first read: re-parsing "until 1 October"
        // a year later would move it, and re-parsing costs a model call for nothing. Stored horizons that have
        // not passed are carried by the stored-record path below.
        candidates.push(stored);
        continue;
      }
      const { item } = matchNote({ text: message.text, items: knownItems });
      // A note naming a programme's alerts belongs to that alert group when no item matched (FR-066).
      const { alertKey } = item
        ? { alertKey: null }
        : matchAlertNote({ text: message.text, alertGroups: alertReplies });
      const parsed = await parseNoteWithModel({
        text: message.text, noteDate: observedDate, engine, model, definition,
      });
      let target = 'brief';
      if (item) {
        target = 'item';
      } else if (alertKey) {
        target = 'alert_group';
      }
      candidates.push({
        feedback_id: feedbackId,
        date: observedDate, run_id: sourceId, target, item_id: item ? item.item_id : null, alert_key: alertKey || null,
        // The note's own thumbs is its verdict (revision 23); the id stays keyed on the note alone, so re-reading it
        // finds the stored record.
        kind: 'note', verdict: noteVerdict(message.text), note: message.text, horizon: parsed.horizon,
        author: message.user, matched: Boolean(item || alertKey), source_ts: message.ts,
      });
      if (item && parsed.horizon) {
        const meta = itemMeta.get(item.item_id) || {};
        horizons.push({
          item_id: item.item_id,
          project_url: item.project_url || meta.project_url || null,
          metric: item.metric || meta.metric || null,
          pattern_card: item.pattern_card === undefined ? (meta.pattern_card || null) : item.pattern_card,
          horizon: parsed.horizon, expected_max: parsed.expected_max, observed_value: evidenceValue(item),
          note: message.text, author_count: 1, source_run_id: sourceId,
        });
      }
    }
    sources.push({ run_id: sourceId, parent_ts: parentTs, replies: itemReplies.length, notes: notes.length, fallback });
    logger.info('feedback.source', {
      run_id: sourceId, parent_ts: parentTs, replies: itemReplies.length, notes: notes.length, fallback,
    });
  }

  const validated = candidates.map((record) => schemas.Feedback.parse(record));
  const fresh = validated.filter((record) => !existingIds.has(record.feedback_id));
  const result = await appendRecords(dataDir, fresh);
  logger.info('feedback.records', { appended: result.appended, skipped: result.skipped, sources: sources.length });

  const all = await readAll(dataDir);
  const byItem = {};
  const alerts = {};
  const brief = { up: 0, down: 0, notes: [] };
  const projects = {};
  const metaFor = createMetaLookup(dataDir, itemMeta);
  const knownHorizons = new Set(horizons.map((h) => `${h.item_id}|${h.horizon}`));
  for (const record of all) {
    const inWindow = record.date >= windowStart;
    if (record.target === 'alert_group' && record.alert_key) {
      // Tallied for the digest only; alert feedback never changes ranking (FR-066).
      if (!alerts[record.alert_key]) {
        alerts[record.alert_key] = { up: 0, down: 0, retracted: 0, notes: [] };
      }
      if (inWindow) {
        applyRecord(alerts[record.alert_key], record);
      }
      continue;
    }
    if (record.target === 'item' && record.item_id) {
      if (!byItem[record.item_id]) {
        byItem[record.item_id] = emptyCounts(await metaFor(record));
      }
      const counts = byItem[record.item_id];
      if (inWindow) {
        applyRecord(counts, record);
      }
      applyHorizon(counts, record, observedDate);
      const projectUrl = counts.project_url;
      if (projectUrl) {
        (projects[projectUrl] = projects[projectUrl] || []).push(record);
      }
      // A stored note whose horizon has not passed keeps suppressing (FR-060), even once its post is out of the
      // look-back and the record out of the window; today's parse of the same note wins when both exist.
      const key = `${record.item_id}|${record.horizon}`;
      if (record.kind === 'note' && record.horizon && record.horizon >= observedDate && !knownHorizons.has(key)) {
        knownHorizons.add(key);
        horizons.push({
          item_id: record.item_id, project_url: counts.project_url, metric: counts.metric,
          pattern_card: counts.pattern_card, horizon: record.horizon, expected_max: null, observed_value: null,
          note: record.note, author_count: 1, source_run_id: record.run_id, source: 'stored',
        });
      }
    } else if (inWindow) {
      applyRecord(brief, record);
    }
  }
  for (const counts of Object.values(byItem)) {
    counts.verdict = verdictOf(counts);
    counts.up = Math.max(0, counts.up);
    counts.down = Math.max(0, counts.down);
  }
  brief.up = Math.max(0, brief.up);
  brief.down = Math.max(0, brief.down);
  for (const counts of Object.values(alerts)) {
    counts.up = Math.max(0, counts.up);
    counts.down = Math.max(0, counts.down);
  }

  return {
    run_id: runId,
    since,
    sources,
    records: fresh,
    unmatched: fresh.filter((record) => record.kind === 'note' && !record.matched),
    horizons,
    by_item: byItem,
    alerts,
    brief: { up: brief.up, down: brief.down, notes: brief.notes },
    projects,
    influence: { days: influenceDays, window_start: windowStart },
    records_path: path.resolve(dataPaths(dataDir).feedbackFile),
  };
};

module.exports = { ingestFeedback, previousRuns, windowStartFor, VERDICTS, DEFAULT_INFLUENCE_DAYS };
