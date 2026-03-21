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
│  /api/mcp?owner=medic&name=cht-watchdog──┤   │
│  /api/mcp?owner=medic&name=cht-sync    ──┘   │
│                                              │
│  Web UI (port 3000)                          │  ← not routed, admin via port-forward
│  Backend API (port 8080)                     │
│  SQLite + cloned repos on EBS PVC            │
└──────────────────────────────────────────────┘
```

**MCP tools exposed per indexed repo** ([source](https://github.com/AIDotNet/OpenDeepWiki/blob/6546253/src/OpenDeepWiki/MCP/McpRepositoryTools.cs)):

| Tool | Parameters | Description |
|------|-----------|-------------|
| `ListRepositories` | *(none)* | List all repositories the caller can access |
| `GetDocumentCatalog` | `owner`, `name`, `language?` | Get the wiki table of contents (document paths and titles) |
| `ReadDocument` | `owner`, `name`, `path`, `startLine?`, `endLine?`, `language?` | Read a specific wiki page (max 200 lines per request) |
| `SearchDocuments` | `owner`, `name`, `query`, `language?` | Full-text search across all documents, returns matching paths and snippets |

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
    },
    "cht-sync-wiki": {
      "type": "http",
      "url": "https://opendeepwiki.dev.medicmobile.org/api/mcp?owner=medic&name=cht-sync"
    }
  }
}
```

## System Admin Prerequisites

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

Do NOT commit real keys. Create the secret directly with all three API key fields (same key for all):

```bash
kubectl create secret generic opendeepwiki-secret \
  --namespace=mcp-servers \
  --from-literal=CHAT_API_KEY='sk-ant-your-actual-key' \
  --from-literal=WIKI_CATALOG_API_KEY='sk-ant-your-actual-key' \
  --from-literal=WIKI_CONTENT_API_KEY='sk-ant-your-actual-key'
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
   kubectl logs -n mcp-servers -l app.kubernetes.io/name=opendeepwiki -f --container opendeepwiki
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
kubectl port-forward -n mcp-servers svc/opendeepwiki 8080:8080
curl -X POST http://localhost:8080/api/reindex
```

## Security

### Why the web UI is not publicly exposed

OpenDeepWiki allows anyone with web UI access to submit arbitrary repositories for indexing. Each indexing run consumes Anthropic API credits. There is no built-in rate limiting or per-user quota.

To prevent unauthorized cost exposure:

1. **Only `/api/mcp` is routed via ingress** — these endpoints are read-only queries against already-indexed repos
2. **All write operations** (adding repos, triggering re-indexes) require `kubectl port-forward`, which requires cluster access
3. **Set a spend limit** in the [Anthropic console](https://console.anthropic.com/settings/billing) as an additional safety net

### Anthropic API keys

Three API key fields are stored in a Kubernetes Secret (`opendeepwiki-secret`): `CHAT_API_KEY`, `WIKI_CATALOG_API_KEY`, and `WIKI_CONTENT_API_KEY`. All three use the same Anthropic key. They are never placed in the ConfigMap or committed to git. The `deploy/secret.yaml` contains only `REPLACE_ME` placeholders — create the real secret via `kubectl create secret` as shown above.

## Environment Variables

### ConfigMap (`opendeepwiki-config`)

| Variable | Value | Description |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | `Production` | ASP.NET runtime environment |
| `URLS` | `http://+:8080` | Backend listen address |
| `DB_TYPE` | `sqlite` | Database backend |
| `CONNECTION_STRING` | `Data Source=/data/opendeepwiki.db` | SQLite file path inside PVC |
| `CHAT_REQUEST_TYPE` | `Anthropic` | Primary AI provider type |
| `ENDPOINT` | `https://api.anthropic.com` | Primary API endpoint |
| `WIKI_CATALOG_MODEL` | `claude-haiku-4-5-20251001` | Model for wiki structure/catalog generation |
| `WIKI_CATALOG_ENDPOINT` | `https://api.anthropic.com` | Catalog generation endpoint |
| `WIKI_CATALOG_REQUEST_TYPE` | `Anthropic` | Catalog generation provider type |
| `WIKI_CONTENT_MODEL` | `claude-haiku-4-5-20251001` | Model for wiki page content generation |
| `WIKI_CONTENT_ENDPOINT` | `https://api.anthropic.com` | Content generation endpoint |
| `WIKI_CONTENT_REQUEST_TYPE` | `Anthropic` | Content generation provider type |
| `WIKI_PARALLEL_COUNT` | `3` | Max concurrent wiki generation tasks |
| `WIKI_LANGUAGES` | `en` | Languages for generated documentation |
| `REPOSITORIES_DIRECTORY` | `/data` | Path for cloned repo storage inside PVC |
| `READ_MAX_TOKENS` | `140000` | Max tokens read from files during indexing (70% of 200K context) |
| `AUTO_CONTEXT_COMPRESS_ENABLED` | `true` | AI-powered conversation compression for MCP chat sessions |
| `AUTO_CONTEXT_COMPRESS_TOKEN_LIMIT` | `100000` | Token count that triggers compression |
| `AUTO_CONTEXT_COMPRESS_MAX_TOKEN_LIMIT` | `200000` | Hard ceiling matching Haiku 4.5 context window |
| `JWT_SECRET_KEY` | *(change in ConfigMap)* | Secret for JWT token signing |

### Secret (`opendeepwiki-secret`)

| Variable | Description |
|---|---|
| `CHAT_API_KEY` | Anthropic API key for primary chat |
| `WIKI_CATALOG_API_KEY` | Anthropic API key for catalog generation |
| `WIKI_CONTENT_API_KEY` | Anthropic API key for content generation |

All three keys use the same Anthropic API key. They are separated because OpenDeepWiki supports using different providers/keys for each stage.

### Cursor

Add the same URLs under Settings > MCP Servers.

## Troubleshooting

**Pod in CrashLoopBackOff:**
```bash
kubectl logs -n mcp-servers -l app.kubernetes.io/name=opendeepwiki --previous --container opendeepwiki
```
Common causes: invalid API key, wrong model name, PVC not bound.

**MCP endpoint returns empty response:**
The repository hasn't been indexed yet. Port-forward to the web UI and check indexing status.

**Indexing appears stuck:**
Check logs and consider lowering `TASK_MAX_SIZE_PER_USER` to serialize work:
```bash
kubectl logs -n mcp-servers -l app.kubernetes.io/name=opendeepwiki -f --container opendeepwiki
```

**Unexpected Anthropic costs:**
- Reduce `WIKI_PARALLEL_COUNT` to `"1"` to serialize indexing
- Check the Anthropic dashboard and lower the monthly spend limit
