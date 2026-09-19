'use strict';
// Posting to the one configured channel (contracts/slack-payload.md): private image upload referenced by
// id, one parent, one threaded reply per item, permalinks recorded, retries on rate limits, loud failure
// (FR-019 to FR-024).
const fs = require('node:fs');
const codes = require('../cli/exit-codes');
const { withImageBlock, BRIEF_EVENT } = require('./payload');

const DEFAULT_ATTEMPTS = 3;
const defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const retryDelayMs = (error, attempt) => {
  const retryAfter = error && error.data && Number(error.data.retryAfter);
  return retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
};

const fileIdOf = (result) => {
  const groups = (result && result.files) || [];
  for (const group of groups) {
    const files = group && group.files;
    if (files && files.length && files[0].id) {
      return files[0].id;
    }
  }
  return null;
};

/**
 * @param {object} options client (WebClient-like), channel, logger, pace (between posts), sleep (backoff), attempts
 */
const createSlackPublisher = ({
  client, channel, logger, pace = async () => {}, sleep = defaultSleep, attempts = DEFAULT_ATTEMPTS,
}) => {
  const call = async (label, fn) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (attempt === attempts) {
          const detail = `Slack ${label} failed after ${attempts} attempts: ${message}`;
          throw new codes.ExitError(codes.IOERR, detail, { label });
        }
        const waitMs = retryDelayMs(error, attempt);
        logger.warn('slack.retry', { label, attempt, wait_ms: waitMs, error: message });
        await sleep(waitMs);
      }
    }
    return null;
  };

  const permalinkOf = async (ts) => {
    const result = await call('chat.getPermalink', () => client.chat.getPermalink({ channel, message_ts: ts }));
    return (result && result.permalink) || null;
  };

  const post = async (message) => call('chat.postMessage', () => client.chat.postMessage({ channel, ...message }));

  const uploadImage = async (image, imagePath) => {
    const result = await call('files.uploadV2', () => client.files.uploadV2({
      file: fs.createReadStream(imagePath),
      filename: image.filename,
      title: image.alt_text,
      alt_text: image.alt_text,
    }));
    const fileId = fileIdOf(result);
    if (!fileId) {
      throw new codes.ExitError(codes.IOERR, 'Slack files.uploadV2 returned no file id', { label: 'files.uploadV2' });
    }
    return fileId;
  };

  const supersededBlock = (permalink) => ({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Supersedes an earlier post for this date: <${permalink}|earlier brief>` }],
  });

  const publish = async ({ payload, imagePath, superseded = null }) => {
    let post_ = payload;
    let fileId = null;
    if (payload.image && imagePath) {
      fileId = await uploadImage(payload.image, imagePath);
      post_ = withImageBlock(payload, fileId);
      logger.info('slack.image_uploaded', { file_id: fileId });
    }
    let blocks = post_.parent.blocks;
    if (superseded) {
      blocks = [supersededBlock(superseded), ...blocks];
    }
    const parent = await post({
      text: post_.parent.text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
      metadata: post_.parent.metadata,
    });
    logger.info('slack.parent_posted', { ts: parent.ts });
    const replies = [];
    for (const reply of post_.replies) {
      await pace();
      const posted = await post({
        text: reply.text, blocks: reply.blocks, thread_ts: parent.ts, metadata: reply.metadata,
      });
      replies.push({ item_id: reply.item_id, ts: posted.ts, permalink: await permalinkOf(posted.ts) });
    }
    return {
      channel_id: parent.channel || channel,
      ts: parent.ts,
      permalink: await permalinkOf(parent.ts),
      replies,
      slack_file_id: fileId,
    };
  };

  const postTextOnly = async (payload) => {
    const posted = await post({ text: payload.parent.text, metadata: payload.parent.metadata });
    return {
      channel_id: posted.channel || channel,
      ts: posted.ts,
      permalink: await permalinkOf(posted.ts),
      replies: [],
      slack_file_id: null,
    };
  };

  const postHeartbeat = (payload) => postTextOnly(payload);

  const postFailureNotice = async ({ text, traceUrl = null, runId = null, date = null }) => {
    const message = traceUrl ? `${text} <${traceUrl}|trace>` : text;
    const metadata = { event_type: BRIEF_EVENT, event_payload: { run_id: runId, date, kind: 'failure' } };
    return postTextOnly({ parent: { text: message, metadata } });
  };

  return { publish, postHeartbeat, postFailureNotice, postTextOnly };
};

module.exports = { createSlackPublisher, retryDelayMs, fileIdOf };
