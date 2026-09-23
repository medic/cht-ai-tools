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
