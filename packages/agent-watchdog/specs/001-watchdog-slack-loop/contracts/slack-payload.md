# Contract: Slack Payload, Feedback Reads and App Configuration

Facts about the Slack Web API below were verified against https://docs.slack.dev on 2026-09-19
(research.md R-10 and R-11). The app is an internal, single-workspace app named `agent-watchdog`;
its bot display name is set in the app configuration, so no per-message identity override and no
`chat:write.customize` scope is used (FR-047).

## App configuration (managed outside this package, documented here)

| Item | Value |
|---|---|
| Bot display name | `agent-watchdog` |
| Bot token scopes | `chat:write`, `files:write`, `reactions:read`, `channels:history`; add `groups:history` only if `#agents` becomes private |
| Channel membership | the bot is invited to `#agents`; posting and reading both require membership (`not_in_channel` otherwise) |
| Message metadata schemas (app manifest, `metadata.event_subscriptions`) | `agent_watchdog.brief` with `run_id`, `date`, `kind`; `agent_watchdog.item` with `run_id`, `item_id`, `project_url`, `metric`. Unregistered metadata is ignored by Slack with a warning, so registration is part of the app setup checklist. |
| Rate-limit class | internal customer-built app: `conversations.history` and `conversations.replies` keep Tier 3 and the normal `limit` values; the 2025 one-request-per-minute limit applies only to non-Marketplace apps distributed commercially |

## Publishing sequence (`src/publish/slack.js`)

1. **Upload the brief image** with `files.uploadV2({ file: <Buffer>, filename: 'brief-<run_id>.png',
   title, alt_text })` and **no `channel_id`**, so the file stays private to the bot token. The id
   is read from `result.files[0].files[0].id`. `files.upload` is sunset (12 November 2025) and is
   never called.
2. **Post the parent message** with `chat.postMessage({ channel, text, blocks, unfurl_links: false,
   unfurl_media: false, metadata })`. `text` is the plain-text fallback (headline plus bullets).
   Blocks, at most 50, in order: `header` (headline), one `section` per bullet with `mrkdwn`,
   an `image` block `{ type: 'image', slack_file: { id }, alt_text }` (the bot that uploaded the
   file is the bot posting, which is the documented requirement), a `context` block with the
   expected-load or degradation notice when present, one `context` block per code-added notice
   (for example a project new since the previous run), and a `context` footer with the prompts,
   configuration and trace links and the cost in currency.
3. **Post one threaded reply per item** with `chat.postMessage({ channel, thread_ts: <parent ts>,
   text, blocks, metadata: { event_type: 'agent_watchdog.item', event_payload } })`, highest rank
   first, body items first. Replies are never broadcast.
4. **Record** `chat.getPermalink({ channel, message_ts })` for the parent and each reply into
   `publication.json`; permalinks of thread replies carry `thread_ts` and `cid`.
5. A forced re-run posts a new parent whose first context block links the superseded post's
   permalink; it does not edit or delete the earlier post.

Heartbeat and failure notices are single `chat.postMessage` calls with `text` only and the
`agent_watchdog.brief` metadata (`kind: heartbeat | failure`). Posting is paced to one message per
second per channel; the client's built-in retry handles `429` with `Retry-After`.

## Payload object (`payload.json`, also the preview output)

```json
{
  "run_id": "2026-09-19",
  "kind": "brief",
  "parent": { "channel": "C…", "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.brief", "event_payload": { "run_id": "2026-09-19", "date": "2026-09-19", "kind": "brief" } } },
  "image": { "filename": "brief-2026-09-19.png", "alt_text": "…", "path": "rollup/brief.png", "slack_file_id": null },
  "replies": [
    { "item_id": "a1b2c3d4e5f6", "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.item", "event_payload": { "run_id": "2026-09-19", "item_id": "a1b2c3d4e5f6", "project_url": "https://…", "metric": "…" } } }
  ]
}
```

In preview mode `slack_file_id` stays null and nothing is sent; after publishing,
`publication.json` adds `ts`, `permalink` and `slack_file_id`.

## Text rules enforced by the gate before publishing

- Headline: one line. Bullets: at most three, each at most two lines of at most 120 characters,
  numbers formatted by the shared formatter, no URLs in bullet text (links live in the footer and
  the thread replies).
- Every string is rendered through Handlebars templates under `templates/slack/` with escaping on;
  Slack `mrkdwn` special characters `&`, `<`, `>` in untrusted text are escaped as `&amp;`, `&lt;`,
  `&gt;`.
- Fallback `text` is limited to 4,000 characters.

## Reading feedback (`src/feedback/ingest.js`)

For each of the previous N runs (`AGENT_WATCHDOG_FEEDBACK_LOOKBACK_RUNS`, or since `--since`),
using the `ts` values recorded in that run's `publication.json`:

1. `conversations.replies({ channel, ts: <parent ts>, limit: 1000, include_all_metadata: true })`,
   paging with `cursor`. The first message is the parent; replies carry `thread_ts` and
   `parent_user_id`. Messages authored by the bot (matching `bot_id` or the `agent_watchdog.item`
   metadata) are items; other messages are notes.
2. For every bot message, `reactions.get({ channel, timestamp, full: true })` to obtain the
   complete `reactions[] { name, users[], count }` list, because reaction arrays embedded in
   history payloads may omit users.
3. Map `+1`/`thumbsup` to `up` and `-1`/`thumbsdown` to `down`; a reaction recorded in
   `feedback.jsonl` on a previous ingestion and absent now is recorded as `retracted`. Reactions on
   the parent target the brief. Notes are matched to items by explicit reference (item id, metric
   name or project in the note, resolved by the feedback-parsing stage) or recorded as unmatched.
4. Only when a run's `publication.json` is missing does the ingester fall back to
   `conversations.history({ channel, oldest, latest, include_all_metadata: true })` and identify
   posts by their `agent_watchdog.brief` metadata.

Call volume per run is bounded: at most N parents, their reply pages, and one `reactions.get` per
bot message, paced under the Tier 3 allowance.
