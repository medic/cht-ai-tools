# Contract: Slack Payload, Feedback Reads and App Configuration

Facts about the Slack Web API below were verified against https://docs.slack.dev on 2026-09-19
(research.md R-10 and R-11). The app is an internal, single-workspace app named `agent-watchdog`;
its bot display name is set in the app configuration, so no per-message identity override and no
`chat:write.customize` scope is used (FR-047).

## Markers, patterns and correlation (revision 14)

The payload builder adds emoji markers when it renders (FR-082): the header by brief kind (📋 brief,
🚨 alerts only, ✅ heartbeat, ⚠️ degraded, ❌ failure), each item or programme section by its worst
severity (🔴 🟠 🟡), alert sections with 🚨, and context lines by kind (✅ resolved, 🧹 housekeeping,
🆕 first run or new projects, ⚠️ analysis incomplete or alerts unavailable, 📅 expected load).
`brief.json`, the image alt text and the model's output carry no markers. An alert group's thread
reply opens with one paragraph per programme-wide pattern (`🔁 Programme-wide: <rule> on N of M
projects, first <date>, last <date>` and the hosts) and lists the other instances with the metric
behind the alert (`· <metric> <value> now (yesterday <value>)`). An item reply carries
`🚨 Alert firing: <rule> since <date> (<n>d)` when a firing alert's category covers its metric.

## App configuration (managed outside this package, documented here)

| Item | Value |
|---|---|
| Bot display name | `agent-watchdog` |
| Bot token scopes | `chat:write`, `files:write`, `reactions:read`, `reactions:write` (the "seen" reaction on acknowledged notes, FR-062), `channels:history`; add `groups:history` only if `#agents` becomes private |
| Channel membership | the bot is invited to `#agents`; posting and reading both require membership (`not_in_channel` otherwise) |
| Message metadata schemas (app manifest, `metadata.event_subscriptions`) | `agent_watchdog.brief` with `run_id`, `date`, `kind`; `agent_watchdog.item` with `run_id`, `item_id`, `project_url`, `metric`; `agent_watchdog.feedback_digest` with `run_id`, `date`, `acknowledged` (count); `agent_watchdog.alerts` with `run_id`, `date`, `group`, `category`, `firing` (count) for alert-group replies (FR-066). Unregistered metadata is ignored by Slack with a warning, so registration is part of the app setup checklist. |
| Rate-limit class | internal customer-built app: `conversations.history` and `conversations.replies` keep Tier 3 and the normal `limit` values; the 2025 one-request-per-minute limit applies only to non-Marketplace apps distributed commercially |

## Publishing sequence (`src/publish/slack.js`)

1. **Upload the brief image** with `files.uploadV2({ file: <Buffer>, filename: 'brief-<run_id>.png',
   title, alt_text })` and **no `channel_id`**, so the file stays private to the bot token. The id
   is read from `result.files[0].files[0].id`. `files.upload` is sunset (12 November 2025) and is
   never called.
2. **Post the parent message** with `chat.postMessage({ channel, text, blocks, unfurl_links: false,
   unfurl_media: false, metadata })`. `text` is the plain-text fallback (headline plus bullets).
   Blocks, at most 50, in order: `header` (headline), one `section` per top-level bullet with
   `mrkdwn` (at most five; the bullet's lines, then each sub-bullet on its own line prefixed by
   three spaces and `◦`, at most eight, since Slack has no nested lists; the indentation's rendering
   is smoke test S-16), an `image` block `{ type: 'image', slack_file: { id }, alt_text }` (the bot that uploaded the
   file is the bot posting, which is the documented requirement), a `context` block with the
   expected-load or degradation notice when present, one `context` block per code-added notice
   (for example a project new since the previous run), and a `context` footer with the prompts,
   configuration and trace links and the cost in currency.
3. **Post one threaded reply per item** with `chat.postMessage({ channel, thread_ts: <parent ts>,
   text, blocks, metadata: { event_type: 'agent_watchdog.item', event_payload } })`, highest rank
   first, body items first, then **one threaded reply per alert group** (`templates/slack/alert-group.hbs`:
   the rule titles, at most fifty instances with host and days firing, the count of the rest, and
   the code-built link to the filtered alert list) with `metadata.event_type: 'agent_watchdog.alerts'`,
   in body order (FR-066). A reply is fitted into one 3,000-character section by code and a link is
   never cut: as many instances as fit, then a pattern's hosts elided to twelve with the count of the
   rest, then the per-rule filtered links dropped, then the links without the host filter
   (`buildAlertGroupLinks(...).short`); `text` and the block carry the same fitted string. Replies are
   never broadcast.
4. **Record** `chat.getPermalink({ channel, message_ts })` for the parent and each reply into
   `publication.json`; permalinks of thread replies carry `thread_ts` and `cid`.
5. A forced re-run posts a new parent whose first context block links the superseded post's
   permalink; it does not edit or delete the earlier post.
6. **Post the feedback digest** (User Story 7), only when the run acknowledged new feedback, as one
   threaded reply under the parent it published that day, brief or heartbeat, with
   `metadata: { event_type: 'agent_watchdog.feedback_digest', event_payload: { run_id, date, acknowledged } }`.
   Its text is built by code from `rollup/feedback.digest.json` through
   `templates/slack/feedback-digest.hbs`: per item the effect applied today, the proposals written
   with destination and path, and one retention sentence naming where the records live permanently
   and how many days they adjust ranking. It names no person. Then `reactions.add({ channel,
   timestamp: <note ts>, name: 'eyes' })` for each acknowledged note; `already_reacted` is not an
   error, any other failure is logged and never fails the run. Nothing is posted or reacted to in
   preview mode.

Heartbeat and failure notices are single `chat.postMessage` calls with `text` only and the
`agent_watchdog.brief` metadata (`kind: heartbeat | failure`); a heartbeat still receives the
feedback digest in its thread when there is feedback to acknowledge. Posting is paced to one message per
second per channel; the client's built-in retry handles `429` with `Retry-After`.

## Payload object (`payload.json`, also the preview output)

```json
{
  "run_id": "2026-09-19",
  "kind": "brief",
  "parent": { "channel": "C…", "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.brief", "event_payload": { "run_id": "2026-09-19", "date": "2026-09-19", "kind": "brief" } } },
  "image": { "filename": "brief-2026-09-19.png", "alt_text": "…", "path": "rollup/brief.png", "slack_file_id": null },
  "replies": [
    { "item_id": "a1b2c3d4e5f6", "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.item", "event_payload": { "run_id": "2026-09-19", "item_id": "a1b2c3d4e5f6", "project_url": "https://…", "metric": "…" } } },
    { "alert_key": "North Programme/backlog", "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.alerts", "event_payload": { "run_id": "2026-09-19", "date": "2026-09-19", "group": "North Programme", "category": "backlog", "firing": 12 } } }
  ],
  "digest": { "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.feedback_digest", "event_payload": { "run_id": "2026-09-19", "date": "2026-09-19", "acknowledged": 3 } }, "acknowledged": [ "<feedback_id>" ], "reactions": [ { "source_ts": "1700000000.000100", "name": "eyes" } ] }
}
```

In preview mode `slack_file_id` stays null and nothing is sent; after publishing,
`publication.json` adds `ts`, `permalink` and `slack_file_id`. `digest` is null when the run
acknowledged nothing new; in preview it is filled but nothing is posted or reacted to, and no
record is marked acknowledged.

## Text rules enforced by the gate before publishing

- Headline: one line. Bullets: at most five top-level, each at most two lines of at most 120
  characters with at most eight one-line sub-bullets (spec revision 9, FR-010, FR-015); numbers
  formatted by the shared formatter; no URLs in bullet or sub-bullet text (links live in the footer
  and the thread replies, including the alert-list links).
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
   metadata) are items, those with `agent_watchdog.alerts` metadata are alert groups (feedback on
   them targets `alert_group` with the `alert_key`); other messages are notes.
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
