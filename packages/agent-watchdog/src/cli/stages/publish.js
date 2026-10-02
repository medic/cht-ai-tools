'use strict';
// Stage: publish. Builds the exact payload, writes it, and posts it unless the run is a preview (FR-019, FR-025).
const { requireInputs } = require('./index');
const codes = require('../exit-codes');
const { buildPayload } = require('../../publish/payload');
const { createSlackPublisher } = require('../../publish/slack');
const { buildDigest } = require('../../publish/digest');
const { provenanceFor } = require('../../publish/provenance');
const { readUnacknowledged, markAcknowledged, feedbackFile } = require('../../feedback/store');
const { buildAlertsLinks } = require('../../links/build');
const { hostOf } = require('../../rollup/deterministic-brief');
const identity = require('../../model/identity');

const name = 'publish';
const inputs = ['rollup/brief.json'];

const slackClient = (ctx) => {
  if (ctx.deps && ctx.deps.slack) {
    return ctx.deps.slack;
  }
  const { WebClient } = require('@slack/web-api');
  return new WebClient(ctx.config.secrets.slackBotToken);
};

const DEFAULT_INFLUENCE_DAYS = 30;

const lookup = (byItem, itemId) => {
  if (!byItem) {
    return undefined;
  }
  return byItem instanceof Map ? byItem.get(itemId) : byItem[itemId];
};

/**
 * What feedback did to each ranked item's confidence, as a direction plus the confidence it now has. The
 * ranked items already carry the adjusted value (src/rollup/rank.js), so no "before" is invented here.
 */
const adjustmentsFor = (items, byItem) => items.map((item) => {
  const entry = lookup(byItem, item.item_id);
  if (!entry) {
    return null;
  }
  const net = (entry.up || 0) - (entry.down || 0);
  let direction = null;
  if (entry.verdict === 'confirmed' && net > 0) {
    direction = 'up';
  } else if (entry.verdict === 'dismissed' && net < 0) {
    direction = 'down';
  }
  return direction ? { item_id: item.item_id, direction, after: item.confidence } : null;
}).filter(Boolean);

const suppressedFor = async (runDir, discovery) => {
  const out = [];
  for (const project of (discovery && discovery.projects) || []) {
    const rel = `${project.slug}/suppressed.json`;
    if (runDir.exists(rel)) {
      const entries = await runDir.readJson(rel);
      out.push(...(Array.isArray(entries) ? entries : []));
    }
  }
  return out;
};

/**
 * Where each acknowledged item's feedback acted (FR-085): read from the run directory for every item with a record
 * to acknowledge, by its project's slug from the discovery or from its host.
 */
const provenanceMap = async ({ runDir, records, byItem, items, discovery }) => {
  const run = await runDir.readRun();
  const slugByUrl = new Map(((discovery && discovery.projects) || []).map((p) => [p.url, p.slug]));
  const idsByItem = new Map();
  for (const record of records) {
    if (record.target === 'item' && record.item_id) {
      if (!idsByItem.has(record.item_id)) {
        idsByItem.set(record.item_id, new Set());
      }
      idsByItem.get(record.item_id).add(record.feedback_id);
    }
  }
  const out = new Map();
  for (const [itemId, feedbackIds] of idsByItem) {
    const entry = lookup(byItem, itemId) || items.find((item) => item.item_id === itemId) || {};
    const url = entry.project_url || null;
    if (!url) {
      continue;
    }
    const slug = slugByUrl.get(url) || identity.projectSlug(hostOf(url));
    out.set(itemId, await provenanceFor({ runDir, run, project: { url, slug }, itemId, feedbackIds }));
  }
  return out;
};

/** Alert Groups in body order (the layout's body alerts, then the thread's), or none when alerting was unavailable. */
const orderedAlertGroups = (classified, layout) => {
  if (!classified || !classified.available) {
    return [];
  }
  const byKey = new Map((classified.groups || []).map((group) => [group.alert_key, group]));
  const order = layout ? [...(layout.body_alerts || []), ...(layout.thread_alerts || [])] : [...byKey.keys()];
  return order.map((key) => byKey.get(key)).filter(Boolean);
};

/** The digest input the feedback stage left for this run, read defensively: nothing there means nothing new. */
const feedbackInputs = async (ctx, runDir) => {
  if (ctx.feedbackIngested) {
    return ctx.feedbackIngested;
  }
  return runDir.exists('feedback.ingested.json') ? runDir.readJson('feedback.ingested.json') : null;
};

const run = async (ctx) => {
  const { runDir, logger } = ctx;
  requireInputs(runDir, inputs);
  const brief = await runDir.readJson('rollup/brief.json');
  // A run posts one parent (FR-042, revision 34): a record of an earlier post, complete or partial, means a
  // retry must supersede it with `run --force` rather than post a second brief for the date. Checked before
  // anything is rebuilt or written (revision 36), so the payload on disk stays the one that was posted.
  const earlier = runDir.exists('rollup/publication.json') ? await runDir.readJson('rollup/publication.json') : null;
  const posted = Boolean(earlier && earlier.ts);
  if (ctx.mode !== 'preview' && posted) {
    throw new codes.ExitError(
      codes.TEMPFAIL,
      `this run already posted its brief as ${earlier.ts}${earlier.partial ? ' (thread incomplete)' : ''}; `
        + 'run --force to supersede it rather than post a second one',
    );
  }
  // A preview of a run that already posted writes beside the record, never over it (revision 37).
  const suffix = ctx.mode === 'preview' && posted ? '.preview' : '';
  const items = runDir.exists('rollup/items.ranked.json') ? await runDir.readJson('rollup/items.ranked.json') : [];
  const discovery = runDir.exists('discovery.json') ? await runDir.readJson('discovery.json') : null;
  const channel = ctx.config.endpoints.slackChannelId || null;

  // The feedback digest (FR-062): every record no earlier digest acknowledged, what it changed today, the
  // proposals written from it, and the retention statement. Nothing new means no digest.
  const dataDir = (ctx.config.storage && ctx.config.storage.dataDir) || runDir.dataDir;
  const ingested = await feedbackInputs(ctx, runDir);
  const unacknowledged = await readUnacknowledged(dataDir);
  const byItem = ctx.feedbackByItem || (ingested && ingested.by_item) || {};
  const influenceDays = (ctx.config.behaviour && ctx.config.behaviour.feedbackInfluenceDays)
    || (ingested && ingested.influence && ingested.influence.days)
    || DEFAULT_INFLUENCE_DAYS;
  const built = buildDigest({
    runId: ctx.runId,
    date: ctx.date,
    records: unacknowledged,
    byItem,
    items,
    adjustments: adjustmentsFor(items, byItem),
    suppressed: await suppressedFor(runDir, discovery),
    review: ingested ? ingested.review : null,
    unmatched: (ingested && ingested.unmatched) || ctx.feedbackUnmatched || [],
    retention: {
      records_path: (ingested && ingested.records_path) || feedbackFile(dataDir), influence_days: influenceDays,
    },
    provenance: await provenanceMap({ runDir, records: unacknowledged, byItem, items, discovery }),
  });

  const classified = runDir.exists('alerts.classified.json') ? await runDir.readJson('alerts.classified.json') : null;
  const layout = runDir.exists('rollup/layout.json') ? await runDir.readJson('rollup/layout.json') : null;
  // The groups the roll-up briefed, which a filtered run narrowed to the projects it analysed; re-deriving them
  // from the classified record would describe a different set in the replies than in the bullets (revision 19).
  const briefed = runDir.exists('rollup/alert-groups.json')
    ? { available: true, groups: await runDir.readJson('rollup/alert-groups.json') }
    : classified;
  const alertGroups = orderedAlertGroups(briefed, layout);
  const grafanaUrl = ctx.config.endpoints && ctx.config.endpoints.grafanaUrl;
  // The alerts reply links each programme's filtered alert list and every firing alert (FR-066, revision 28).
  const alertsLinks = grafanaUrl ? buildAlertsLinks({ grafanaUrl, alertGroups }) : { byGroup: new Map(), all: null };

  const payload = buildPayload({
    brief,
    items,
    runId: ctx.runId,
    date: ctx.date,
    audience: 'internal',
    channel,
    digest: built,
    alertGroups,
    alertsLinks,
  });
  await runDir.writeJson(`rollup/payload${suffix}.json`, payload);
  if (built) {
    await runDir.writeJson(`rollup/feedback.digest${suffix}.json`, built.digest);
    logger.info('publish.digest_built', {
      acknowledged: built.digest.acknowledged.length, items: built.digest.items.length,
      proposals: built.digest.proposals.length, unclassified: built.digest.unclassified,
    });
  }

  if (ctx.mode === 'preview') {
    logger.info('publish.preview', { kind: brief.kind, replies: payload.replies.length, digest: Boolean(built) });
    return { posted: false, payload };
  }

  const publisher = createSlackPublisher({
    client: slackClient(ctx), channel, logger, ...(ctx.deps && ctx.deps.sleep ? { sleep: ctx.deps.sleep } : {}),
  });
  // The record is written as soon as the parent is posted, so a failure in the thread (a reply, the report, the
  // digest) cannot lose it; a heartbeat or failure post gets the same record (revision 36).
  const onParent = (partial) => runDir.writeJson('rollup/publication.json', partial);
  // A forced re-run links the post it supersedes (FR-042), a heartbeat or failure post too (revision 37): the
  // permalink the earlier run recorded, or one looked up now from its ts when that lookup failed at the time.
  const superseded = ctx.supersededPermalink
    || (ctx.supersededTs ? await publisher.permalinkOf(ctx.supersededTs).catch(() => null) : null);
  let publication;
  if (brief.kind === 'heartbeat' || brief.kind === 'failure') {
    publication = await publisher.postTextOnly(payload, { onParent, superseded });
  } else {
    const reportPath = brief.report && brief.report.path && runDir.exists(brief.report.path)
      ? runDir.path(brief.report.path)
      : null;
    publication = await publisher.publish({ payload, reportPath, superseded, onParent });
  }
  if (built) {
    // Digest last, under today's parent; acknowledge only once the digest is out, then the courtesy reactions.
    const digestPublication = await publisher.postDigest({ digest: payload.digest, parentTs: publication.ts });
    const marked = await markAcknowledged(dataDir, built.digest.acknowledged, ctx.runId);
    // The courtesy reaction goes on the notes this digest acknowledged; a note still awaiting its review gets it
    // from the run that finally carries it (revision 34).
    const acknowledgedIds = new Set(built.digest.acknowledged);
    const notes = unacknowledged.filter((record) => record.kind === 'note' && acknowledgedIds.has(record.feedback_id));
    const reactions = await publisher.reactToNotes({ records: notes });
    await runDir.writeJson('rollup/feedback.digest.json', {
      ...built.digest, reactions, publication: digestPublication,
    });
    publication.digest = digestPublication;
    payload.digest.reactions = reactions;
    await runDir.writeJson('rollup/payload.json', payload);
    logger.info('publish.digest_posted', {
      ts: digestPublication.ts, acknowledged: marked, reactions: reactions.filter((r) => r.ok).length,
      reaction_failures: reactions.filter((r) => !r.ok).length,
    });
  }
  await runDir.writeJson('rollup/publication.json', publication);

  brief.publication = { channel_id: publication.channel_id, ts: publication.ts, permalink: publication.permalink };
  if (brief.report && publication.report) {
    brief.report.slack_file_id = publication.report.file_id;
    brief.report.ts = publication.report.ts;
  }
  await runDir.writeJson('rollup/brief.json', brief);
  logger.info('publish.done', { kind: brief.kind, ts: publication.ts, replies: publication.replies.length });
  return { posted: true, ts: publication.ts, permalink: publication.permalink };
};

module.exports = { name, inputs, run, orderedAlertGroups };
