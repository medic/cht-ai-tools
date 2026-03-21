# Patch: Enable Public MCP Endpoint (No OAuth)

## Goal

Make the OpenDeepWiki MCP endpoint (`/api/mcp`) work without requiring Google OAuth credentials. The endpoint should be public and unauthenticated. Abuse prevention will be handled at the infrastructure layer (AWS ALB/WAF rate limiting), not at the application layer.

## Repository

- Source: `~/ai_medic/OpenDeepWiki`
- Current branch HEAD: `0fd6093` (latest upstream as of 2026-03-11)
- File to patch: `src/OpenDeepWiki/Program.cs`

## Problem

MCP is gated behind `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars. If both are not set, the `/api/mcp` route is never registered and returns 404. We do not want Google OAuth because our community may not have Google accounts.

## What to change

There are **3 locations** in `src/OpenDeepWiki/Program.cs` that need modification:

### Location 1: Auth scheme registration (lines 111-116)

**Current code:**
```csharp
    // MCP Google auth scheme (only when GOOGLE_CLIENT_ID is configured)
    var hasMcpAuth = !string.IsNullOrEmpty(builder.Configuration["GOOGLE_CLIENT_ID"]);
    if (hasMcpAuth)
    {
        authBuilder.AddMcpGoogleAuth(builder.Configuration);
    }
```

d**Action:** Leave this block as-is. It's fine — when Google creds aren't set, the MCP auth scheme simply doesn't register. No change needed here.

### Location 2: Authorization policy (lines 118-129)

**Current code:**
```csharp
    builder.Services.AddAuthorization(options =>
    {
        options.AddPolicy("AdminOnly", policy => policy.RequireRole("Admin"));
        if (hasMcpAuth)
        {
            options.AddPolicy(McpAuthConfiguration.McpPolicyName, policy =>
                policy.AddAuthenticationSchemes(
                        JwtBearerDefaults.AuthenticationScheme,
                        McpAuthConfiguration.McpGoogleScheme)
                    .RequireAuthenticatedUser());
        }
    });
```

**Action:** Leave as-is. The MCP policy only registers when `hasMcpAuth` is true. Since we're removing the `RequireAuthorization()` call from the route (Location 3), this policy won't be referenced.

### Location 3: MCP service registration (lines 376-387) — CHANGE REQUIRED

**Current code:**
```csharp
    // MCP server registration (requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
    var mcpEnabled = !string.IsNullOrEmpty(builder.Configuration["GOOGLE_CLIENT_ID"])
                     && !string.IsNullOrEmpty(builder.Configuration["GOOGLE_CLIENT_SECRET"]);
    if (mcpEnabled)
    {
        builder.Services.AddScoped<IMcpUserResolver, McpUserResolver>();
        builder.Services.AddSingleton<McpOAuthServer>();
        builder.Services.AddHostedService<McpOAuthCleanupService>();
        builder.Services.AddMcpServer()
            .WithHttpTransport()
            .WithTools<McpRepositoryTools>();
    }
```

**Replace with:**
```csharp
    // MCP server registration (public, no auth — rate limiting handled at infrastructure layer)
    builder.Services.AddMcpServer()
        .WithHttpTransport()
        .WithTools<McpRepositoryTools>();
```

**Why:** Remove the `mcpEnabled` gate entirely. Register MCP unconditionally. Drop the OAuth-specific services (`IMcpUserResolver`, `McpOAuthServer`, `McpOAuthCleanupService`) — they're only needed for the Google OAuth flow.

### Location 4: MCP route mapping (lines 418-425) — CHANGE REQUIRED

**Current code:**
```csharp
    // MCP server endpoints (only when fully configured with OAuth)
    if (mcpEnabled)
    {
        app.MapMcpOAuthEndpoints();
        app.UseSseKeepAlive("/api/mcp");
        app.MapProtectedResourceMetadata();
        app.MapMcp("/api/mcp").RequireAuthorization(McpAuthConfiguration.McpPolicyName);
    }
```

**Replace with:**
```csharp
    // MCP server endpoints (public, no auth)
    app.UseSseKeepAlive("/api/mcp");
    app.MapMcp("/api/mcp");
```

**Why:** Remove the `if (mcpEnabled)` gate. Drop `MapMcpOAuthEndpoints()` (OAuth discovery/callback routes not needed). Drop `MapProtectedResourceMetadata()` (RFC 9728 metadata not needed). Remove `.RequireAuthorization(...)` so the route is publicly accessible.

## After patching

Rebuild the backend image and push to ECR

```bash
cd ~/ai_medic/OpenDeepWiki
docker build -f src/OpenDeepWiki/Dockerfile -t public.ecr.aws/medic/opendeepwiki-web:backend-mar11 .
docker push public.ecr.aws/medic/opendeepwiki-web:backend-mar11
```

Then update the deployment image tag in `~/ai_medic/cht-ai-tools/mcp-servers/opendeepwiki/deploy/deployment.yaml` from `backend-feb26` to `backend-mar11` and redeploy.

## Verification

```bash
kubectl port-forward -n mcp-servers svc/opendeepwiki 8080:8080

curl -s 'http://localhost:8080/api/mcp?owner=medic&name=cht-conf' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Should return a JSON-RPC response listing the MCP tools (ListRepositories, GetDocumentCatalog, ReadDocument, SearchDocuments).

## Security model after patch

| Surface | Protection |
|---------|-----------|
| MCP endpoint (`/api/mcp`) | Public read-only. Rate-limited at ALB/WAF layer. |
| Admin API (`/api/admin/*`) | Requires admin JWT. Not routed via ingress. |
| Submit endpoint (`/api/v1/repositories/submit`) | Requires login. Not routed via ingress. |
| Web UI (port 3000) | Not routed via ingress. Access via `kubectl port-forward` only. |
| Auth endpoints (`/api/auth/*`) | Not routed via ingress. |

Only `/api/mcp` is publicly reachable via the ALB ingress. All write/admin operations require `kubectl port-forward` (cluster credentials).
