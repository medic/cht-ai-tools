---
name: deploy
description: Launch the CHT deployment web UI for uploading forms and settings to a CHT instance
allowed-tools:
  - Bash
  - Read
---

# /deploy Command

Launch the local deployment web UI for deploying CHT config to an instance.

## Prerequisites

- Must be in a CHT config project directory
- Node.js 18+ installed
- `cht-conf` installed globally (`npm install -g cht-conf`)

## Execution

Start the deployment server:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/deploy-server.js
```

If launching after form creation, pass the form name to pre-select it:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/deploy-server.js --form=patient_assessment_under_5
```

The server will:
1. Bind to `127.0.0.1` on an available port
2. Print a clickable localhost URL
3. Serve the deployment UI from `${CLAUDE_PLUGIN_ROOT}/templates/deploy-ui.html`
4. Execute cht-conf commands from the current working directory
5. Auto-shutdown after 30 minutes of inactivity

Tell the user to open the printed URL in their browser. Credentials are entered in the browser and never touch the AI context.

## Note

The `deploy-server.js` script is implemented in Phase 7. If not yet available, inform the user and suggest running cht-conf commands manually:

```bash
cht --url=https://user:pass@instance --accept-self-signed-certs compile-app-settings upload-app-settings convert-app-forms upload-app-forms upload-resources upload-custom-translations
```
