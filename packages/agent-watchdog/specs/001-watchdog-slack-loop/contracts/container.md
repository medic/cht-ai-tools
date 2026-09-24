# Contract: Container Image

The image is built and published by this package's release (semantic-release) and pinned by tag
in `medic-infrastructure`, which owns the CronJob, ConfigMap, Secret, volume and network-policy
manifests it applies. This contract states what the image needs from the platform and what it
guarantees (FR-083, FR-086, revision 30). Reference manifests that satisfy it, with placeholder hosts,
live under [`deploy/`](../../../deploy/README.md) and are checked by `test/container/` against this
contract and against the egress list the package emits; they are a starting point for the deployment
repository, never a second source of truth.

## Image

| Property | Value |
|---|---|
| Base | `node:22-bookworm-slim` (Node 22 LTS), two stages: dependencies, then the runtime |
| Runtime | the package with production dependencies only, installed from the lockfile with `npm ci --omit=dev --ignore-scripts` (no lifecycle script runs; the one `postinstall` in the tree, `protobufjs`'s version warning, is not needed), including the Agent SDK's `linux-x64` runtime package (about 224 MB) |
| Browser | none. The daily run renders no image since revision 24 (FR-019); Playwright, Chromium and the emoji font left the image in revision 30 (FR-086) |
| User | non-root, fixed UID and GID (`10001:10001`), home `/home/watchdog`, shell `nologin`; the application files are owned by root and read-only to it |
| Entrypoint | `node bin/agent-watchdog.js`; the CronJob passes the command, for example `run` or `calibrate` |
| Baked environment | `NODE_ENV=production`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CONFIG_DIR=/tmp/agent-watchdog-runtime`, `HOME=/home/watchdog`, `TMPDIR=/tmp` |
| Labels | `org.opencontainers.image.source`, `.title`, `.licenses`; `.version` and `.revision` from the `VERSION` and `REVISION` build arguments the release passes |
| Ports | none exposed; the process listens on nothing |
| Size budget | under 700 MB compressed; the runtime binary dominates |

The image contains no secrets, no configuration policy files, no run data and no browser. Its
build-time network need is the npm registry alone; run-time egress is the list below.

## Filesystem expectations

| Path | Mode | Purpose |
|---|---|---|
| `/` | read-only root filesystem | `readOnlyRootFilesystem: true`; nothing under `/app` or `/home/watchdog` is written by a run |
| `/data` | read-write volume (10 Gi) | `AGENT_WATCHDOG_DATA_DIR`; run artefacts, memory, feedback, proposals, corpus index, raw corpus |
| `/etc/agent-watchdog` | read-only ConfigMap mount | `projects.yaml`, `dashboards.yaml`, `thresholds.yaml`, `alerts.yaml` |
| `/tmp` | read-write `emptyDir` | the agent runtime's configuration directory (`CLAUDE_CONFIG_DIR`, created at start; sessions are not persisted, `persistSession: false`), Node temp files, the report smoke's output |

These are the only writable paths (FR-086). The engines create `CLAUDE_CONFIG_DIR` themselves, so an
`emptyDir` mounted over `/tmp` needs no preparation.

## Process and security

- `runAsNonRoot: true`, `runAsUser: 10001`, `runAsGroup: 10001`, `fsGroup: 10001`,
  `allowPrivilegeEscalation: false`, all capabilities dropped, seccomp `RuntimeDefault`,
  `automountServiceAccountToken: false`, no host network, PID or IPC namespace.
- Requests and limits for the deployment to set: CPU request 500m, limit 2; memory request 1 Gi,
  limit 2 Gi (the agent runtime is the driver; the browser that once needed the third gibibyte is
  gone). `activeDeadlineSeconds` exceeds `AGENT_WATCHDOG_RUN_TIMEOUT_MS` by at least ten minutes so
  the package's own timeout produces the failure notice rather than a kill.
- `concurrencyPolicy: Forbid` and `startingDeadlineSeconds` on the CronJob back up FR-047; the
  package still refuses a duplicate date on its own (exit 75).
- Signals: `SIGTERM` triggers a graceful stop that records the run as `failed` and exits 1 when a
  notice can be posted.

## Network egress (FR-083)

`agent-watchdog egress` prints the destinations a run contacts, host and port with the purpose of
each, from the effective configuration (`--format hosts` prints one host per line for a policy). The
platform's network policy is the enforcement of record for everything in the container; inside the
process, every request the package makes through `fetch`, and every library call through the global
`fetch`, passes a guard that refuses any other destination before a connection is made, fails the run
with exit 69 and logs the host and port, never the URL (`src/net/egress.js`). What the guard cannot
see, and the policy must cover alone: the agent runtime's subprocess (the model API and the
documentation service) and the Slack SDK's own transport.

| Destination | Purpose | From |
|---|---|---|
| host of `AGENT_WATCHDOG_GRAFANA_URL`, its port | dashboards, datasource proxy, targets, annotations, alert rules, link resolution | configuration |
| `slack.com`, `files.slack.com`, 443 | Web API, file upload URLs, permalink resolution | code |
| `api.anthropic.com`, 443 | the agent runtime's model calls | code |
| host of `LANGFUSE_BASE_URL`, its port | tracing | configuration |
| host of `AGENT_WATCHDOG_DOCS_MCP_URL`, its port | documentation search (the agent runtime) | configuration |
| hosts of `AGENT_WATCHDOG_SPECS_URL` and `AGENT_WATCHDOG_CONFIG_URL`, their ports | footer link resolution by the gate | configuration |
| `docs.communityhealthtoolkit.org`, `forum.communityhealthtoolkit.org`, `github.com`, 443 | resolving reference links that appeared in tool results (`github.com/medic/` only) | code |

No inbound ports. DNS is the one further egress the pod needs. The runtime's telemetry and update
checks are disabled by the baked environment. The `check <cht-url>` command contacts the host an
operator names and is exempt from the guard; the platform policy refuses it inside the container.
The guard follows a redirect only to a listed destination (it fetches with manual redirects and
re-checks each `Location`, up to five hops); it is installed for `run`, `tools-server`, `calibrate`,
`distill` and `replay`, every command that can reach the network (revision 33). The gate's link resolver
never requests a model-written URL that is off the link allow-list or was not seen in a tool result.

## Running it locally with Compose (revision 31)

`compose.yaml` at the package root runs the same image under the same constraints on a contributor's
machine: user `10001:10001`, read-only root, every capability dropped, `no-new-privileges`, a `/tmp`
tmpfs, a PID limit, the CPU and memory limits above, and `init` for the runtime's subprocesses. Secrets
and endpoints come from the operator's own `.env` (`env_file`), never from the file; that `.env` keeps
comments on their own lines like `.env.example`, because Compose keeps text after `#` on a value line as
part of the value; `AGENT_WATCHDOG_DATA_DIR`,
`AGENT_WATCHDOG_CONFIG_DIR` and `AGENT_WATCHDOG_CORPUS_RAW_DIR` are pinned to the container paths. The
data volume is named `agent-watchdog-data`, the local analogue of the claim; `AGENT_WATCHDOG_COMPOSE_DATA=./data`
binds a host directory instead, which must be writable by uid 10001. The policy files come from
`config/local` (or `AGENT_WATCHDOG_COMPOSE_CONFIG_DIR`), read-only; a file missing there falls back to the
package default. The default command previews (`run --dry-run`); the `offline` profile runs the same image
with no network at all, for the stages that need none: `purge`, `analyze`, `render` and a preview `publish`
(FR-043; `replay` still calls the model and runs in the default service). What the cluster's network policy
enforces has no local equivalent: the package refuses its own requests outside the egress list, and the
runtime subprocess and the Slack SDK are not filtered on a contributor's machine.

### Individual use on a Claude subscription (revision 32)

The image carries the Agent SDK's own Claude Code binary on PATH as `claude`, so the CLI engine
(`AGENT_WATCHDOG_ENGINE=cli`, `claude -p`) and a login need nothing installed. `docker compose --profile
login run --rm login` runs `claude auth login` interactively; the login lands in the named volume
`agent-watchdog-login`, mounted at the runtime user's home by every service, with `CLAUDE_CONFIG_DIR`
pointing into it. A run with the CLI engine and `ANTHROPIC_API_KEY` blank is then in login mode
(contracts/agent-definition.md): no `--bare`, `--setting-sources ""`, no tools, no session persistence; a
key present wins and ignores the login. The volume holds an OAuth token for the contributor's account: it
is a named volume, never a bind mount into the repository or the image, read-write because the runtime
refreshes the token, cleared with `auth logout`, and it is the third and last writable path of the local
setup. The login flow and the token refresh reach `platform.claude.com` (the runtime's OAuth authorize and token
endpoints), which is not on the scheduled run's egress list because the scheduled run never logs in.

## Exit codes and logs

Exit codes per [exit-codes.md](./exit-codes.md). Logs are JSON lines on stderr; command results
on stdout. The platform collects both streams; nothing is written to log files.

## Contract checks in CI (SC-017)

`smoke/container.js --no-build --image <tag>` runs the built image under the platform's constraints
(`--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --user 10001:10001`, and
`--network none` where no network is needed): `--version` prints the package version; `egress
--format hosts` lists the destinations for a placeholder configuration; `check https://example.invalid`
exits 69; `smoke/render.js` renders the fixture report writing under `/tmp` alone. `test/container/`
checks the `Dockerfile`, `.dockerignore` and the reference manifests without Docker.
