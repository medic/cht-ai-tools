# OpenDeepWiki — CHT Code Context Layer

Self-hosted [OpenDeepWiki](https://github.com/AIDotNet/OpenDeepWiki) deployment that generates AI-powered wiki documentation from CHT repositories and exposes it via MCP endpoints for AI agent consumption.

**Design document:** [Code Context Layer recommendation](https://github.com/medic/cht-agent/blob/main/designs/layer_recommendations/code-context-layer.md)

## Architecture

```
AI Agent (Claude Code / Cursor)
    │
    ▼  MCP (Streamable HTTP)
┌──────────────────────────────────────────────┐
│  opendeepwiki.dev.medicmobile.org            │
│                                              │
│  /api/mcp?owner=medic&name=cht-core    ──┐   │
│  /api/mcp?owner=medic&name=cht-conf    ──┤   │  ← public (read-only)
│  /api/mcp?owner=medic&name=cht-watchdog──┘   │
│                                              │
│  Web UI (port 3000)                          │  ← not routed, admin via port-forward
│  Backend API (port 5085)                     │
│  SQLite + cloned repos on EBS PVC            │
└──────────────────────────────────────────────┘
```

**MCP tools exposed per indexed repo:**
- `read_wiki_structure` — get the wiki table of contents
- `read_wiki_contents` — read a specific wiki page
- `ask_question` — ask a natural-language question about the codebase

## Prerequisites

- EKS cluster with the AWS ALB Ingress Controller
- `kubectl` configured for the target cluster
- An Anthropic API key
- DNS record for `opendeepwiki.dev.medicmobile.org` pointing to the ALB

## Deployment

### 1. Namespace should already be created. 

The `mcp-servers` namespace is shared across all MCP server deployments:

```bash
kubectl apply -f mcp-servers/namespace.yaml
```

### 2. Create the API key secret

Do NOT commit real keys. Create the secret directly:

```bash
kubectl create secret generic opendeepwiki-secret \
  --namespace=mcp-servers \
  --from-literal=CHAT_API_KEY='sk-ant-your-actual-key'
```

### 3. Apply all manifests

```bash
kubectl apply -f mcp-servers/opendeepwiki/deploy/
```

### 4. Verify

```bash
kubectl get pods -n mcp-servers            # STATUS: Running
kubectl get pvc -n mcp-servers             # STATUS: Bound
kubectl get ingress -n mcp-servers         # ADDRESS: ALB DNS name
kubectl logs -n mcp-servers -l app.kubernetes.io/name=opendeepwiki -f
```

## Indexing Repositories

The web UI is not publicly exposed. Use `kubectl port-forward` to access it for admin tasks like adding repositories.

### Phased approach 

Index one small repository first to validate the setup and measure real Anthropic costs before indexing larger repos. We'll follow indexing cht-conf in the example commands below.

**Step 1 — Open the admin UI locally**

```bash
kubectl port-forward -n mcp-servers svc/opendeepwiki 8090:3000
```

Then open http://localhost:8090 in your browser.

**Step 2 — Index cht-conf**

1. In the web UI, submit: `https://github.com/medic/cht-conf`
2. Monitor indexing progress:
   ```bash
   kubectl logs -n mcp-servers -l app.kubernetes.io/name=opendeepwiki -f --container koalawiki
   ```
3. Once complete, browse the generated wiki in the web UI to verify quality

**Step 3 — Check Anthropic costs**

1. Go to the [Anthropic billing dashboard](https://console.anthropic.com/settings/billing)
2. Note the cost of the cht-conf indexing run
3. Extrapolate for larger repos — cht-core has roughly 10-20x more code
4. Set a monthly spend limit as a safety net before proceeding

**Step 4 — Validate the MCP endpoint**

```bash
curl -s 'https://opendeepwiki.dev.medicmobile.org/api/mcp?owner=medic&name=cht-conf' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Or test from Claude Code by adding to your `.mcp.json`:

```json
{
  "mcpServers": {
    "cht-conf-wiki": {
      "type": "http",
      "url": "https://opendeepwiki.dev.medicmobile.org/api/mcp?owner=medic&name=cht-conf"
    }
  }
}
```

Then ask: *"Using the cht-conf-wiki, what does the compile-app-settings command do?"*

**Step 5 — Index remaining repos (after cost validation)**

Once you're satisfied with the cost, repeat the port-forward + web UI submission for:

- `https://github.com/medic/cht-core` (master branch) — largest, expect higher cost
- `https://github.com/medic/cht-watchdog` (main branch)

### Automatic re-indexing

`UPDATE_INTERVAL` in the ConfigMap (default: `7` days) controls automatic incremental updates. Incremental re-indexes only process changed files and are cheaper than full re-indexes.

### Manual re-indexing

Port-forward to the backend and hit the re-index API:

```bash
kubectl port-forward -n mcp-servers svc/opendeepwiki 5085:5085
curl -X POST http://localhost:5085/api/reindex
```

## Security

### Why the web UI is not publicly exposed

OpenDeepWiki allows anyone with web UI access to submit arbitrary repositories for indexing. Each indexing run consumes Anthropic API credits. There is no built-in rate limiting or per-user quota.

To prevent unauthorized cost exposure:

1. **Only `/api/mcp` is routed via ingress** — these endpoints are read-only queries against already-indexed repos
2. **All write operations** (adding repos, triggering re-indexes) require `kubectl port-forward`, which requires cluster access
3. **Set a spend limit** in the [Anthropic console](https://console.anthropic.com/settings/billing) as an additional safety net

### Anthropic API key

The API key is stored in a Kubernetes Secret (`opendeepwiki-secret`). It is never placed in the ConfigMap or committed to git. The `deploy/secret.yaml` contains only a `REPLACE_ME` placeholder — create the real secret via `kubectl create secret` as shown above.

## Cost Estimates

Using Claude Sonnet 4.6 via Anthropic API with weekly re-indexing:

| Repository | Estimated size | Initial index | Weekly re-index |
|---|---|---|---|
| cht-conf | ~15k LOC | ~$1-3 | ~$0.50 |
| cht-watchdog | ~5k LOC | ~$0.50-1 | ~$0.25 |
| cht-core | ~200k+ LOC | ~$15-30 | ~$3-8 |
| **Total** | | **~$17-34** | **~$4-9/week** |

**Estimated monthly cost: $20-40** (all three repos, weekly re-indexing).

## Environment Variables

| Variable | Value | Description |
|---|---|---|
| `CHAT_MODEL` | `claude-sonnet-4-6` | Primary model (must support function calling) |
| `ANALYSIS_MODEL` | `claude-sonnet-4-6` | Model for directory structure analysis |
| `MODEL_PROVIDER` | `Anthropic` | AI provider |
| `ENDPOINT` | `https://api.anthropic.com` | Anthropic API endpoint |
| `CHAT_API_KEY` | *(in Secret)* | Anthropic API key — never in ConfigMap |
| `DB_TYPE` | `sqlite` | Database backend |
| `DB_CONNECTION_STRING` | `Data Source=/data/KoalaWiki.db` | SQLite file path inside PVC |
| `LANGUAGE` | `English` | Language for generated documentation |
| `TASK_MAX_SIZE_PER_USER` | `5` | Max concurrent indexing tasks per user |
| `UPDATE_INTERVAL` | `7` | Days between automatic incremental re-indexes |
| `EnableSmartFilter` | `true` | AI-powered filtering of irrelevant directories |
| `KOALAWIKI_REPOSITORIES` | `/repositories` | Path for cloned repo storage inside PVC |

## MCP Client Configuration

### Claude Code

Add to project or global `.mcp.json`:

```json
{
  "mcpServers": {
    "cht-core-wiki": {
      "type": "http",
      "url": "https://opendeepwiki.dev.medicmobile.org/api/mcp?owner=medic&name=cht-core"
    },
    "cht-conf-wiki": {
      "type": "http",
      "url": "https://opendeepwiki.dev.medicmobile.org/api/mcp?owner=medic&name=cht-conf"
    },
    "cht-watchdog-wiki": {
      "type": "http",
      "url": "https://opendeepwiki.dev.medicmobile.org/api/mcp?owner=medic&name=cht-watchdog"
    }
  }
}
```

### Cursor

Add the same URLs under Settings > MCP Servers.

## Troubleshooting

**Pod in CrashLoopBackOff:**
```bash
kubectl logs -n mcp-servers -l app.kubernetes.io/name=opendeepwiki --previous --container koalawiki
```
Common causes: invalid API key, wrong model name, PVC not bound.

**MCP endpoint returns empty response:**
The repository hasn't been indexed yet. Port-forward to the web UI and check indexing status.

**Indexing appears stuck:**
Check logs and consider lowering `TASK_MAX_SIZE_PER_USER` to serialize work:
```bash
kubectl logs -n mcp-servers -l app.kubernetes.io/name=opendeepwiki -f --container koalawiki
```

**Unexpected Anthropic costs:**
- Increase `UPDATE_INTERVAL` to re-index less frequently
- Set `TASK_MAX_SIZE_PER_USER: "1"` to limit parallel indexing
- Ensure `EnableSmartFilter: "true"` to skip irrelevant directories (e.g. `node_modules`, vendored code)
- Check the Anthropic dashboard and lower the monthly spend limit
