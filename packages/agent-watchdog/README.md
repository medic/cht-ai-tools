# agent-watchdog

Daily analysis of the CHT projects monitored by Medic's hosted [CHT Watchdog](https://docs.communityhealthtoolkit.org/hosting/monitoring/),
posted to Slack as a short brief that flags what a human should look into. It reads metrics
through Grafana, computes changes deterministically, asks a bounded Claude Agent SDK session to
interpret them with read-only tools, verifies every number and link in code, and posts one
message with one threaded reply per item. Reactions and thread notes shape the next day's brief.

It flags; it never acts. Paging stays with the existing monitoring stack.

Specification, plan and contracts live under [`specs/001-watchdog-slack-loop/`](specs/001-watchdog-slack-loop/);
the constitution under [`.specify/memory/constitution.md`](.specify/memory/constitution.md) is the
authority for how this package is built. `AGENTS.md` is the quick reference for coding agents.

## Quickstart

See [`specs/001-watchdog-slack-loop/quickstart.md`](specs/001-watchdog-slack-loop/quickstart.md).
In short:

```sh
nvm use                      # Node 22
npm ci
cp .env.example .env         # fill in credentials
npm run lint && npm test
node --env-file=.env bin/agent-watchdog.js run --dry-run --date 2026-09-18 > payload.json
```

## Commands

`run`, `replay`, `distill`, `calibrate`, `check <cht-url>`, `purge`, `tools-server`.
Flags, streams and exit codes: [`contracts/cli.md`](specs/001-watchdog-slack-loop/contracts/cli.md),
[`contracts/exit-codes.md`](specs/001-watchdog-slack-loop/contracts/exit-codes.md).

## Contracts for deployment

Deployment manifests live in `medic-infrastructure`. This package exposes:
[environment variables](specs/001-watchdog-slack-loop/contracts/environment.md) (`.env.example` is
the source of truth), [mounted configuration files](specs/001-watchdog-slack-loop/contracts/config-files.md),
the [container image](specs/001-watchdog-slack-loop/contracts/container.md) and
[exit codes](specs/001-watchdog-slack-loop/contracts/exit-codes.md).

## Dependencies

Every runtime dependency carries a one-line justification (constitution V):

| Package | Why |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | The analysis engine: bounded sessions, MCP tools, hooks, structured output (ESM-only, loaded with dynamic `import()`). |
| `@modelcontextprotocol/sdk` | Serves the local read-only tools over stdio to the `claude` CLI engine; already a dependency of the Agent SDK. |
| `@slack/web-api` | Posting, threaded replies, file upload, reading reactions and replies. |
| `zod` | Startup validation of configuration, entity schemas, and the source of the structured-output JSON schemas. |
| `yaml` | The three policy files are YAML; Node has no parser. |
| `handlebars` | Escaping templates for the report and Slack text; untrusted text is never concatenated. |
| `playwright-core` | Renders the brief image from the same report as the text, with network and scripting disabled. |
| `@langfuse/tracing`, `@langfuse/otel`, `@langfuse/client`, `@opentelemetry/sdk-node` | One trace per run with a span per stage and usage per model call; the classic `langfuse` package describes itself as a deprecated v3 client. |

## Smoke tests

Scripts under `smoke/` need real credentials and are not part of `npm test`; see the quickstart.

## Releasing

semantic-release from this directory with tags `agent-watchdog-v<version>`; the release builds and
publishes the container image. See `release.config.js`.

## License

AGPL-3.0, like the other CHT tools.
