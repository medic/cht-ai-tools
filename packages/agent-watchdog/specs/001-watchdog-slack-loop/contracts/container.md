# Contract: Container Image

The image is built and published by this package's release (semantic-release) and pinned by tag
in `medic-infrastructure`, which owns the CronJob, ConfigMap, Secret and volume manifests. This
contract states what the image needs from the platform and what it guarantees.

## Image

| Property | Value |
|---|---|
| Base | `node:22-bookworm-slim` (Node 22 LTS; the official Playwright images default to Node 24 and are not used) |
| Runtime | the package with production dependencies only (`npm ci --omit=dev`), including the Agent SDK's `linux-x64` runtime package (about 224 MB) |
| Browser | Chromium headless shell installed at build time with `npx playwright-core install --with-deps chromium-headless-shell` into `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, so browser and library versions move together. Since revision 24 the daily run renders no image (FR-019); the browser is kept for a possible panel-capture story and can be dropped, with its memory, if that story is declined (research.md R-29) |
| User | non-root, fixed UID and GID (`10001:10001`), home `/home/watchdog` |
| Entrypoint | `node bin/agent-watchdog.js`; the CronJob passes the command, for example `run` or `calibrate` |
| Baked environment | `NODE_ENV=production`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CONFIG_DIR=/tmp/agent-watchdog-runtime`, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, `TMPDIR=/tmp` |
| Labels | `org.opencontainers.image.version`, `.revision`, `.source` set from the release |
| Size budget | under 900 MB compressed; the runtime binary and the browser dominate |

The image contains no secrets, no configuration policy files and no run data.

## Filesystem expectations

| Path | Mode | Purpose |
|---|---|---|
| `/` | read-only root filesystem | `readOnlyRootFilesystem: true` is expected |
| `/data` | read-write volume (10 Gi) | `AGENT_WATCHDOG_DATA_DIR`; run artefacts, memory, feedback, proposals, corpus index, raw corpus |
| `/etc/agent-watchdog` | read-only ConfigMap mount | `projects.yaml`, `dashboards.yaml`, `thresholds.yaml` |
| `/tmp` | read-write `emptyDir` | Playwright temp directories and profile, the agent runtime's config directory, Node temp files |
| `/dev/shm` | default | Chromium runs with `--disable-dev-shm-usage` by default, so no enlarged shared memory is required |

## Process and security

- `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, all capabilities dropped, seccomp
  `RuntimeDefault`. Chromium runs without its own sandbox (Playwright's default `--no-sandbox`),
  which is acceptable because the page rendered is the package's own template with JavaScript
  disabled and every network request aborted.
- Requests and limits are documented for the deployment to set: CPU request 500m, limit 2;
  memory request 1 Gi, limit 3 Gi (headless Chromium and the agent runtime are the drivers).
  `activeDeadlineSeconds` should exceed `AGENT_WATCHDOG_RUN_TIMEOUT_MS` by at least ten minutes so
  the package's own timeout produces the failure notice rather than a kill.
- `concurrencyPolicy: Forbid` and `startingDeadlineSeconds` on the CronJob back up FR-047; the
  package still refuses a duplicate date on its own (exit 75).
- Signals: `SIGTERM` triggers a graceful stop that records the run as `failed` and exits 1 when a
  notice can be posted.

## Network egress (allow-list for the platform's network policy)

| Destination | Purpose |
|---|---|
| host of `AGENT_WATCHDOG_GRAFANA_URL`, 443 | dashboards, datasource proxy, targets, annotations, link resolution |
| `slack.com`, `files.slack.com`, 443 | Web API, file upload URLs, permalink resolution |
| `api.anthropic.com`, 443 | the agent runtime's model calls |
| host of `LANGFUSE_BASE_URL`, 443 | tracing |
| host of `AGENT_WATCHDOG_DOCS_MCP_URL`, 443 | documentation search |
| hosts of `AGENT_WATCHDOG_SPECS_URL` and `AGENT_WATCHDOG_CONFIG_URL`, 443 | footer link resolution by the gate |
| `docs.communityhealthtoolkit.org`, `forum.communityhealthtoolkit.org`, `github.com`, 443 | resolving reference links that appeared in tool results |

No inbound ports. No DNS names beyond the above are contacted; the runtime's telemetry and
update checks are disabled by the baked environment.

## Exit codes and logs

Exit codes per [exit-codes.md](./exit-codes.md). Logs are JSON lines on stderr; command results
on stdout. The platform collects both streams; nothing is written to log files.

## Contract checks in CI

- `smoke/render.js` renders a fixture report inside the built image with the root filesystem
  read-only and only `/tmp` and a data directory writable.
- `smoke/agent-parity.js` runs one recorded project through both engines inside the image.
- `docker run --rm <image> --version` prints the package version; `check https://example.invalid`
  exits 69.
