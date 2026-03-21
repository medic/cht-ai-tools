# OpenDeepWiki API Reference & Troubleshooting

Internal reference for managing the OpenDeepWiki deployment. Backend runs on port 8080.

## Access Patterns

**Public endpoints** — accessible without authentication:
```bash
kubectl port-forward -n mcp-servers svc/opendeepwiki 8080:8080
curl http://localhost:8080/api/v1/...
```

**Admin endpoints** — require JWT with Admin role:
```bash
# 1. Get a token
TOKEN=$(curl -s -X POST 'http://localhost:8080/api/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['accessToken'])")

# 2. Use it
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/admin/...
```

**Web UI** — port-forward the frontend (port 3000):
```bash
kubectl port-forward -n mcp-servers svc/opendeepwiki 8090:3000
# Then open http://localhost:8090
```

---

## Key Endpoints

### Repository Documentation (public, no auth)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/v1/repos/{owner}/{repo}/tree` | Wiki sidebar structure (catalog) |
| GET | `/api/v1/repos/{owner}/{repo}/docs/{*slug}` | Get document content by slug |
| GET | `/api/v1/repos/{owner}/{repo}/branches` | List branches and languages |
| GET | `/api/v1/repos/{owner}/{repo}/processing-logs` | Processing log entries |
| GET | `/api/v1/repos/{owner}/{repo}/mindmap` | Architecture mind map |
| GET | `/api/v1/repos/{owner}/{repo}/check` | Check if GitHub repo exists |

**Example — get the wiki tree:**
```bash
curl -s http://localhost:8080/api/v1/repos/medic/cht-conf/tree | python3 -m json.tool
```

**Example — get a specific document:**
```bash
curl -s http://localhost:8080/api/v1/repos/medic/cht-conf/docs/1-overview/1-introduction | python3 -m json.tool
```

**Example — find all documents missing content:**
```bash
curl -s http://localhost:8080/api/v1/repos/medic/cht-conf/tree | python3 -c "
import json, sys, urllib.request
data = json.load(sys.stdin)
def get_leaves(nodes):
    results = []
    for n in nodes:
        if n['children']:
            results.extend(get_leaves(n['children']))
        else:
            results.append(n['slug'])
    return results
slugs = get_leaves(data['nodes'])
missing = []
for s in slugs:
    try:
        r = urllib.request.urlopen(f'http://localhost:8080/api/v1/repos/medic/cht-conf/docs/{s}')
        d = json.loads(r.read())
        if not d.get('content'):
            missing.append(s)
    except:
        missing.append(s)
print(f'Total: {len(slugs)}, Missing content: {len(missing)}')
for m in missing:
    print(f'  {m}')
"
```

### Repository Management (requires login)

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/v1/repositories/submit` | Submit new repo for indexing |
| GET | `/api/v1/repositories/list` | List repos (params: `isPublic`, `page`, `pageSize`) |
| POST | `/api/v1/repositories/regenerate` | Regenerate repo (user-facing) |
| GET | `/api/v1/repositories/branches?gitUrl={url}` | Fetch branches from git platform |

**Example — list all public repos:**
```bash
curl -s 'http://localhost:8080/api/v1/repositories/list?isPublic=true&page=1&pageSize=10' | python3 -m json.tool
```

### Authentication

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/login` | Login, returns JWT token |
| POST | `/api/auth/register` | Register new user |
| GET | `/api/auth/me` | Get current user (requires auth) |

**Default admin:** See upstream OpenDeepWiki docs. Change the default password on first login.

### Admin Repository Management (requires Admin JWT)

All routes under `/api/admin/repositories` require `Authorization: Bearer <admin-token>`.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/repositories?page=1&pageSize=10` | List repos (paginated) |
| GET | `/api/admin/repositories/{id}` | Get repo details |
| GET | `/api/admin/repositories/{id}/management` | Deep management info (branches, languages) |
| PUT | `/api/admin/repositories/{id}/status` | Update repo status |
| POST | `/api/admin/repositories/{id}/regenerate` | Full regeneration (re-does everything) |
| POST | `/api/admin/repositories/{id}/documents/regenerate` | Regenerate specific document |
| PUT | `/api/admin/repositories/{id}/documents/content` | Manually update document content |
| DELETE | `/api/admin/repositories/{id}` | Delete repository |

**Example — set repo status to Pending (triggers full reprocessing):**
```bash
curl -X PUT "http://localhost:8080/api/admin/repositories/${REPO_ID}/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": 0}'
```

**Example — regenerate a single document:**
```bash
curl -X POST "http://localhost:8080/api/admin/repositories/${REPO_ID}/documents/regenerate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"branchId": "BRANCH_ID", "languageCode": "en", "documentPath": "3-cli-actions/5-contact-management/1-create-users"}'
```

### Admin Settings

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/settings?category=ai` | Get settings (filter by category) |
| PUT | `/api/admin/settings` | Update settings |

### Incremental Updates

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/v1/repositories/{repoId}/branches/{branchId}/incremental-update` | Trigger incremental update |
| GET | `/api/v1/incremental-updates/{taskId}` | Get task status |
| POST | `/api/v1/incremental-updates/{taskId}/retry` | Retry failed task |

### MCP Endpoints (read-only, for AI agent consumption)

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/mcp?owner={owner}&name={repo}` | MCP endpoint per indexed repo |

---

## Repository Status Values

| Status | Value | Description |
|--------|-------|-------------|
| Pending | 0 | Queued for processing |
| Processing | 1 | Currently being indexed |
| Completed | 2 | Indexing finished |
| Failed | 3 | Indexing failed |

---

## Known Issues & Workarounds

### 1. Pre-built image missing `/app/prompts/` directory

**Symptom:** `FileNotFoundException: Prompt file 'catalog-generator.md' not found in directory '/app/prompts'`

**Cause:** The upstream Docker image (`crpi-j9ha7sxwhatgtvj4.cn-shenzhen.personal.cr.aliyuncs.com/open-deepwiki/opendeepwiki`) does not include the prompt templates.

**Fix:** Mount prompts as a ConfigMap (already applied in `deploy/prompts-configmap.yaml`).

### 2. Rate limits cause content generation failures (429 errors)

**Symptom:** `AI agent execution failed after 3 attempts` for most/all documents.

**Cause:** Anthropic Tier 1 limits (30K input tokens/min for Sonnet, 50K for Haiku). Content generation prompts send the full repo context and can exceed per-minute token limits.

**Fix:** Use `claude-haiku-4-5-20251001` instead of `claude-sonnet-4-6`. Haiku has higher token limits on Tier 1 and is cheaper. Update via Admin UI > Settings, NOT just the ConfigMap (DB settings override env vars).

### 3. Admin UI settings override ConfigMap environment variables

**Symptom:** Changing `WIKI_PARALLEL_COUNT` or model names in the ConfigMap has no effect after first run.

**Cause:** On first startup, settings are seeded from env vars into the SQLite database. After that, the app reads from the DB and ignores env var changes.

**Fix:** Always change settings via the Admin UI (http://localhost:8090 > Admin Panel > Settings). Update the ConfigMap too for consistency, but the DB takes precedence.

### 4. `Parallel.ForEachAsync` parallelism is set once per content generation loop

**Symptom:** Changing `WIKI_PARALLEL_COUNT` mid-run has no effect on the current run.

**Cause:** The `ParallelOptions` object is created once when the content generation loop starts.

**Fix:** Let the current run finish, then Regenerate. The new parallelism value takes effect on the next run.

### 5. Setting repo status to "Pending" triggers full reprocessing

**Symptom:** All pages regenerated, not just the failed ones.

**Cause:** `GetAllCatalogPaths()` returns all catalog items without checking if content already exists. `GenerateDocumentContentAsync()` does not skip pages with existing content.

**Fix:** Use per-document regeneration via `POST /api/admin/repositories/{id}/documents/regenerate` for individual failed pages. Requires `branchId`, `languageCode`, and `documentPath`.

### 6. Admin `/management` endpoint returns 404

**Symptom:** `GET /api/admin/repositories/{id}/management` returns 404 even with valid ID and auth token.

**Status:** Unresolved. The repository ID matches the one returned by the list endpoint. May be a bug in the upstream `GetRepositoryManagementAsync` implementation. Workaround: use the public tree endpoint to inspect document status.

### 7. Web UI shows untranslated i18n keys in admin panel

**Symptom:** Admin panel shows raw translation keys like `admin.repositories.management.notFound`.

**Cause:** The web frontend is missing translations for the admin repository management view.

**Status:** Cosmetic issue. Use the API directly as a workaround.

### 8. npm ci fails when building the web image

**Symptom:** `npm ci` fails during `docker compose build` because `package-lock.json` doesn't exist.

**Cause:** The project uses bun (has `bun.lock`), but the Dockerfile used `npm ci`.

**Fix:** Updated the web Dockerfile to use `oven/bun:1-alpine` for the deps stage with `bun install --frozen-lockfile`.

### 9. DELETE is a soft-delete — re-submitting a deleted repo fails

**Symptom:** After deleting a repo via the admin API or UI, `POST /api/v1/repositories/submit` for the same repo returns an error (duplicate key).

**Cause:** `DELETE /api/admin/repositories/{id}` sets `IsDeleted=1` but the unique index on `(OwnerUserId, OrgName, RepoName)` does not exclude soft-deleted rows. The submit endpoint rejects the insert because the row still exists.

**Fix:** Instead of deleting and re-submitting, reset the existing repo to Pending status via the admin API:
```bash
curl -X PUT "http://localhost:8080/api/admin/repositories/${REPO_ID}/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": 0}'
```
If the repo was already soft-deleted, use the db-repair procedure below to set `IsDeleted=0, Status=0` directly.

---

## Database Repair Procedure (db-repair pod)

When the admin API is insufficient (e.g. soft-deleted records, schema corruption), use a temporary pod with sqlite3 mounted on the same PVC. This avoids copying DB files over the network, which can cause corruption if the app is still writing.

**Backups:** The PVC is backed by an AWS EBS volume. EBS snapshots provide point-in-time backups. If the DB is corrupted beyond repair, restore the EBS snapshot and recreate the PVC from it.

### Step 1: Scale down OpenDeepWiki

```bash
kubectl scale deployment/opendeepwiki -n mcp-servers --replicas=0
```

Wait for the app pod to terminate before proceeding.

### Step 2: Create a repair pod with sqlite3 on the PVC

```bash
kubectl run db-repair -n mcp-servers --image=alpine:3.19 --restart=Never \
  --overrides='{
    "spec": {
      "containers": [{"name":"db-repair","image":"alpine:3.19",
        "command":["sh","-c","apk add --no-cache sqlite && sleep 3600"],
        "volumeMounts":[{"name":"data","mountPath":"/data"}]}],
      "volumes": [{"name":"data","persistentVolumeClaim":{"claimName":"opendeepwiki-data"}}]
    }
  }'
kubectl wait --for=condition=Ready pod/db-repair -n mcp-servers --timeout=120s
```

If the pod already exists from a previous run:
```bash
kubectl delete pod db-repair -n mcp-servers --wait
# then re-run the kubectl run command above
```

### Step 3: Inspect or repair

**Check integrity:**
```bash
kubectl exec -n mcp-servers db-repair -- sqlite3 /data/opendeepwiki.db "PRAGMA integrity_check;"
```

**List all repos and status:**
```bash
kubectl exec -n mcp-servers db-repair -- sqlite3 /data/opendeepwiki.db \
  "SELECT Id, OrgName, RepoName, IsDeleted, Status FROM Repositories;"
```

Status values: `0=Pending, 1=Processing, 2=Completed, 3=Failed`

**Un-delete and reset a repo to Pending:**
```bash
kubectl exec -n mcp-servers db-repair -- sqlite3 /data/opendeepwiki.db \
  "UPDATE Repositories SET IsDeleted = 0, Status = 0 WHERE RepoName='cht-sync';"
```

**Recover a corrupted DB:**
```bash
kubectl exec -n mcp-servers db-repair -- sh -c '
  sqlite3 /data/opendeepwiki.db ".recover" | sqlite3 /data/recovered.db && \
  mv /data/opendeepwiki.db /data/opendeepwiki.db.corrupt && \
  rm -f /data/opendeepwiki.db-wal /data/opendeepwiki.db-shm && \
  mv /data/recovered.db /data/opendeepwiki.db
'
```

**Nuke the DB (fresh start):**
```bash
kubectl exec -n mcp-servers db-repair -- rm -f /data/opendeepwiki.db /data/opendeepwiki.db-wal /data/opendeepwiki.db-shm
```

**Interactive sqlite3 shell:**
```bash
kubectl exec -it -n mcp-servers db-repair -- sqlite3 /data/opendeepwiki.db
```

### Step 4: Clean up and restart

```bash
kubectl delete pod db-repair -n mcp-servers
kubectl scale deployment/opendeepwiki -n mcp-servers --replicas=1
```

### Step 5: Re-trigger processing via the admin API

If a repo was reset to `Status=0`, the background worker picks it up automatically on startup.

To reset via API instead of direct DB access (preferred when the repo is not soft-deleted):
```bash
# Port-forward
kubectl port-forward -n mcp-servers svc/opendeepwiki 8080:8080

# Get admin token
TOKEN=$(curl -s -X POST 'http://localhost:8080/api/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['accessToken'])")

# Reset to Pending (triggers full reprocessing)
curl -X PUT "http://localhost:8080/api/admin/repositories/${REPO_ID}/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": 0}'
```

After a fresh DB nuke, re-submit repos:
```bash
curl -X POST 'http://localhost:8080/api/v1/repositories/submit' \
  -H 'Content-Type: application/json' \
  -d '{"gitUrl": "https://github.com/medic/cht-sync", "branch": "main"}'
```

---

## Current Repository IDs

| Repo | ID | Status |
|------|----|--------|
| medic/cht-conf | `5b3d1857-70cf-4ec3-b8aa-9b3f64fb7e41` | Completed (with missing content pages) |
| medic/cht-sync | `ded4a5a7-a40f-4566-aeeb-8ef1b958cad9` | Completed |
| medic/cht-watchdog | `11d15b1e-65f1-4d84-8e29-c8f42f1025ab` | Completed |
| medic/cht-core | `aa196c6c-4940-4e3c-89fe-a98ae1d958ed` | Completed |
