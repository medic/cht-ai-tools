'use strict';
// Read reactions and notes from the previous runs' posts (FR-026 to FR-029; contracts/slack-payload.md).
const path = require('node:path');
const { RunDir, dataPaths } = require('../store/run-dir');
const { schemas } = require('../model/schemas');
const identity = require('../model/identity');
const { updateRecords, appendRecords, readAll } = require('./store');
const { matchNote, matchAlertNote, noteVerdict } = require('./match');
const { parseNoteWithModel } = require('./parse-notes');
const { threadOrder, clarifiedWhole } = require('./sequence');

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

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The calendar day a Slack message was written, from its `ts` (seconds), held between the day of the post it
 * answers (a reply is never older than its thread) and the day it was read; the latter when the `ts` is unreadable.
 */
const noteDateOf = (ts, { earliest, latest }) => {
  const seconds = Number(String(ts || '').split('.')[0]);
  const written = Number.isFinite(seconds) && seconds > 0 ? isoDate(seconds * 1000) : latest;
  if (earliest && written < earliest) {
    return earliest;
  }
  return latest && written > latest ? latest : written;
};

/** The parse outcomes a later run with a model retries (revision 34): a failure, never a definite answer. */
const RETRY_SOURCES = new Set(['model-failed', 'model-invalid']);

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
  // What today's parse found for each new note, and each matched item's current value, for the horizons below.
  const parsedToday = new Map();
  const observedByItem = new Map();
  // The model calls the horizon parses made, for the run's cost (FR-049, revision 34).
  const calls = [];
  // Stored notes whose earlier parse failed and which a model re-read today (revision 34).
  const reparsed = new Map();

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
      // What is on record for this message, per author and verdict: how often the reaction was added and how often
      // it was retracted. A reaction added again after a recorded retraction is a new record with a numbered id,
      // and a second retraction likewise (revision 34); the first of each keeps the id it always had.
      const history = previous.filter((record) => record.kind === 'reaction' && record.source_ts === target.ts);
      const tally = (author, verdict) => ({
        added: history.filter((r) => r.author === author && r.verdict === verdict).length,
        retracted: history.filter((r) => r.author === author && r.verdict === 'retracted'
          && r.note === `retracted: ${verdict}`).length,
      });
      for (const reaction of reactions) {
        const verdict = VERDICTS[reaction.name];
        if (!verdict) {
          continue;
        }
        for (const author of reaction.users || []) {
          present.add(`${author}|${verdict}`);
          const { added, retracted } = tally(author, verdict);
          if (added > retracted) {
            continue;
          }
          const sequence = added === 0 ? verdict : `${verdict}#${added}`;
          candidates.push({
            feedback_id: identity.feedbackId(target.ts, author, 'reaction', sequence),
            date: observedDate, run_id: sourceId, target: target.target, item_id: target.item_id,
            alert_key: target.alert_key || null,
            kind: 'reaction', verdict, note: null, horizon: null, author, matched: true, source_ts: target.ts,
          });
        }
      }
      const live = new Map();
      for (const record of history) {
        if (record.verdict === 'up' || record.verdict === 'down') {
          live.set(`${record.author}|${record.verdict}`, record);
        }
      }
      for (const [key, record] of live) {
        const { added, retracted } = tally(record.author, record.verdict);
        if (present.has(key) || added <= retracted) {
          continue;
        }
        const sequence = retracted === 0 ? 'retracted' : `retracted#${retracted}`;
        candidates.push({
          feedback_id: identity.feedbackId(target.ts, record.author, 'reaction', sequence),
          date: observedDate, run_id: record.run_id, target: record.target, item_id: record.item_id,
          alert_key: record.alert_key || null,
          kind: 'reaction', verdict: 'retracted', note: `retracted: ${record.verdict}`, horizon: null,
          author: record.author, matched: true, source_ts: target.ts,
        });
      }
    }

    const knownItems = items.length
      ? items
      : itemReplies.map((r) => ({ item_id: r.item_id, ...(itemMeta.get(r.item_id) || {}) }));
    // Match every note first, so the notes on one item can be read together in thread order (FR-085).
    const entries = [];
    for (const message of notes) {
      const feedbackId = identity.feedbackId(message.ts, message.user, 'note', null);
      const stored = existingIds.has(feedbackId) ? previous.find((r) => r.feedback_id === feedbackId) : null;
      if (stored) {
        // A note already on record keeps the horizon fixed when it was first read: re-parsing "until 1 October"
        // a year later would move it, and re-parsing costs a model call for nothing. The one exception (revision
        // 34) is a note whose model parse failed: with a model present it is read again, against its own date.
        const retry = engine && !stored.horizon && RETRY_SOURCES.has(stored.horizon_source);
        entries.push({
          message, feedbackId, stored, item: null, alertKey: null, itemId: stored.item_id || null, retry,
          sourceDate: runDate,
        });
        if (!retry) {
          candidates.push(stored);
        }
        continue;
      }
      const { item } = matchNote({ text: message.text, items: knownItems });
      // A note naming a programme's alerts belongs to that alert group when no item matched (FR-066).
      const { alertKey } = item
        ? { alertKey: null }
        : matchAlertNote({ text: message.text, alertGroups: alertReplies });
      entries.push({
        message, feedbackId, stored: null, item, alertKey, itemId: item ? item.item_id : null, sourceDate: runDate,
      });
    }
    const threads = new Map();
    for (const entry of entries) {
      if (entry.itemId) {
        if (!threads.has(entry.itemId)) {
          threads.set(entry.itemId, []);
        }
        threads.get(entry.itemId).push(entry);
      }
    }
    for (const entry of entries) {
      if (entry.stored && !entry.retry) {
        continue;
      }
      const { message, feedbackId, item, alertKey } = entry;
      // The earlier notes of the same thread are the parser's context for a note that states no date of its own.
      const thread = entry.itemId ? threads.get(entry.itemId) : [];
      const earlierNotes = thread.slice(0, thread.indexOf(entry)).map((e) => e.message.text);
      // A horizon is read against the day the note was written (revision 34): "until 30 September" read weeks
      // later still means that September.
      const noteDate = noteDateOf(message.ts, { earliest: entry.sourceDate || null, latest: observedDate });
      const parsed = await parseNoteWithModel({
        text: message.text, noteDate, engine, model, definition, earlierNotes,
      });
      if (parsed.call) {
        calls.push(parsed.call);
      }
      if (RETRY_SOURCES.has(parsed.source)) {
        logger.warn('feedback.parse_failed', {
          feedback_id: feedbackId, source: parsed.source, retry: 'the next run with a model reads it again',
        });
      }
      if (entry.stored) {
        // The retried record keeps its identity and everything else; only what the parse found changes.
        const updated = {
          ...entry.stored,
          horizon: parsed.horizon,
          expected_max: parsed.expected_max === undefined ? null : parsed.expected_max,
          horizon_source: parsed.source,
        };
        reparsed.set(feedbackId, updated);
        candidates.push(updated);
        if (parsed.horizon) {
          logger.info('feedback.parse_retried', { feedback_id: feedbackId, horizon: parsed.horizon });
        }
        parsedToday.set(feedbackId, parsed);
        continue;
      }
      parsedToday.set(feedbackId, parsed);
      if (item) {
        observedByItem.set(item.item_id, evidenceValue(item));
      }
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
        // finds the stored record. The horizon is the note's own statement; the one applied is the thread's (below).
        kind: 'note', verdict: noteVerdict(message.text), note: message.text, horizon: parsed.horizon,
        author: message.user, matched: Boolean(item || alertKey), source_ts: message.ts,
        // What the parse found besides the date, kept on the record (revision 34).
        expected_max: parsed.expected_max === undefined ? null : parsed.expected_max,
        observed_value: item ? evidenceValue(item) : null,
        horizon_source: parsed.source,
      });
    }
    sources.push({ run_id: sourceId, parent_ts: parentTs, replies: itemReplies.length, notes: notes.length, fallback });
    logger.info('feedback.source', {
      run_id: sourceId, parent_ts: parentTs, replies: itemReplies.length, notes: notes.length, fallback,
    });
  }

  const validated = candidates.map((record) => schemas.Feedback.parse(record));
  const fresh = validated.filter((record) => !existingIds.has(record.feedback_id));
  const result = await appendRecords(dataDir, fresh);
  if (reparsed.size) {
    await updateRecords(dataDir, (record) => reparsed.get(record.feedback_id) || record);
  }
  logger.info('feedback.records', {
    appended: result.appended, skipped: result.skipped, reparsed: reparsed.size, sources: sources.length,
  });

  const all = await readAll(dataDir);
  const byItem = {};
  const alerts = {};
  const brief = { up: 0, down: 0, notes: [] };
  const projects = {};
  const metaFor = createMetaLookup(dataDir, itemMeta);
  const itemNotes = new Map();
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
      const projectUrl = counts.project_url;
      if (projectUrl) {
        (projects[projectUrl] = projects[projectUrl] || []).push(record);
      }
      if (record.kind === 'note') {
        if (!itemNotes.has(record.item_id)) {
          itemNotes.set(record.item_id, []);
        }
        itemNotes.get(record.item_id).push(record);
      }
    } else if (inWindow) {
      applyRecord(brief, record);
    }
  }
  // The notes on one item are one conversation (FR-085, revision 29): in thread order over every stored note, the
  // last stated horizon is the one applied, on the item's tallies and as the one horizon the analysis suppresses
  // by; a statement a later note corrected is never pushed, and a horizon that has passed holds nothing back
  // (FR-060: a stored horizon keeps suppressing until its date, whatever the influence window).
  // Each record carries what its parse found (revision 34); a record from before that carries null.
  const expectedMaxOf = (record) => {
    if (parsedToday.has(record.feedback_id)) {
      return parsedToday.get(record.feedback_id).expected_max;
    }
    return record.expected_max === undefined ? null : record.expected_max;
  };
  for (const [itemId, records] of itemNotes) {
    const ordered = threadOrder(records);
    const whole = clarifiedWhole(ordered.map((record) => ({ ...record, expected_max: expectedMaxOf(record) })));
    const counts = byItem[itemId];
    const active = Boolean(whole.horizon) && whole.horizon >= observedDate;
    counts.horizon = active ? whole.horizon : null;
    if (!active) {
      continue;
    }
    const setter = [...ordered].reverse().find((record) => record.horizon === whole.horizon) || null;
    // The value the item showed when the note was written: today's reading of the item, else the record's.
    const observedStored = [...ordered].reverse()
      .map((record) => record.observed_value)
      .find((value) => value !== null && value !== undefined);
    horizons.push({
      item_id: itemId, project_url: counts.project_url, metric: counts.metric, pattern_card: counts.pattern_card,
      horizon: whole.horizon, expected_max: whole.expected_max,
      observed_value: observedByItem.has(itemId) ? observedByItem.get(itemId) : (observedStored ?? null),
      note: whole.note, author_count: whole.author_count, source_run_id: setter ? setter.run_id : null,
      source: setter && parsedToday.has(setter.feedback_id) ? 'parsed' : 'stored',
    });
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
    calls,
  };
};

module.exports = { ingestFeedback, previousRuns, windowStartFor, VERDICTS, DEFAULT_INFLUENCE_DAYS };
