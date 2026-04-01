/**
 * deploy-server.js
 *
 * Lightweight Node.js HTTP server for the CHT deployment UI.
 * Zero external dependencies — uses only Node.js built-ins.
 *
 * Usage:
 *   node deploy-server.js
 *
 * The server binds to 127.0.0.1 on port 3853 (or the next available port),
 * serves the deploy UI, and exposes a small REST/SSE API for running cht-conf
 * commands against a CHT instance.
 *
 * Auto-shuts down after 30 minutes of inactivity.
 */

'use strict';

const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { spawn }    = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HOST            = '127.0.0.1';
const PREFERRED_PORT  = 3853;
const INACTIVITY_MS   = 30 * 60 * 1000; // 30 minutes

// Path to the static UI file (relative to this script's location)
const UI_FILE = path.resolve(__dirname, '..', 'templates', 'deploy-ui.html');

// ---------------------------------------------------------------------------
// Inactivity timer
// ---------------------------------------------------------------------------

let inactivityTimer = null;

/**
 * Reset the inactivity shutdown timer.
 * Called on every incoming request so the server only exits after a full
 * 30 minutes with no activity.
 */
function resetInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }
  inactivityTimer = setTimeout(() => {
    console.log('\nNo activity for 30 minutes — shutting down CHT deploy server.');
    process.exit(0);
  }, INACTIVITY_MS);
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the request comes from a localhost origin.
 * Accepts http://localhost:*, http://127.0.0.1:*, and an empty/absent Origin
 * (e.g. same-origin requests from the file system or the server itself).
 */
function isAllowedOrigin(origin) {
  if (!origin) return true; // no Origin header → same-origin or tool request
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * Set permissive CORS headers only for allowed localhost origins.
 */
function setCorsHeaders(req, res) {
  const origin = req.headers['origin'] || '';
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// ---------------------------------------------------------------------------
// Body parser
// ---------------------------------------------------------------------------

/**
 * Read the full POST body and parse it as JSON.
 * Rejects bodies larger than 64 KiB.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const MAX_BYTES = 64 * 1024;
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// cht-conf command builder
// ---------------------------------------------------------------------------

/**
 * Build the argv array for spawning cht-conf.
 *
 * @param {string}  url              - Full URL including credentials, e.g.
 *                                     "https://user:pass@instance.app"
 * @param {boolean} acceptSelfSigned - Whether to pass --accept-self-signed-certs
 * @param {string}  command          - The cht-conf sub-command/action
 * @returns {string[]} argv (everything after "cht")
 *
 * Security note: the URL (which contains credentials) is passed as a discrete
 * argument to spawn(), never interpolated into a shell string, so it cannot be
 * used for shell injection.  We never log the URL.
 */
function buildChtArgs(url, acceptSelfSigned, command, forms) {
  const args = [`--url=${url}`];
  if (acceptSelfSigned) {
    args.push('--accept-self-signed-certs');
  }
  // The command may be a single word or multiple space-separated tokens
  // (e.g. "compile-app-settings upload-app-settings").  Split safely.
  args.push(...command.trim().split(/\s+/).filter(Boolean));
  // If specific forms provided, append "-- form1 form2" for selective upload
  if (Array.isArray(forms) && forms.length > 0) {
    args.push('--');
    args.push(...forms);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Route: GET /
// ---------------------------------------------------------------------------

function handleRoot(req, res) {
  fs.readFile(UI_FILE, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Could not read UI file: ${UI_FILE}\n${err.message}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Route: GET /api/project-info
// ---------------------------------------------------------------------------

function handleProjectInfo(req, res) {
  const cwd  = process.cwd();
  const name = path.basename(cwd);
  // Check for --form arg (pre-select a just-created form)
  const preselect = process.argv.find(a => a.startsWith('--form='));
  const defaultForm = preselect ? preselect.split('=')[1] : null;
  sendJson(res, 200, { path: cwd, name, defaultForm });
}

// ---------------------------------------------------------------------------
// Route: GET /api/forms  (list available app forms)
// ---------------------------------------------------------------------------

function handleListForms(req, res) {
  const formsDir = path.join(process.cwd(), 'forms', 'app');
  try {
    const files = fs.readdirSync(formsDir);
    const forms = files
      .filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'))
      .map(f => f.replace('.xlsx', ''))
      .sort();
    // Check for --form arg to mark as pre-selected
    const preselect = process.argv.find(a => a.startsWith('--form='));
    const defaultForm = preselect ? preselect.split('=')[1] : null;
    sendJson(res, 200, { forms, defaultForm });
  } catch (err) {
    sendJson(res, 200, { forms: [], defaultForm: null, error: 'forms/app/ not found' });
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/run  (SSE streaming)
// ---------------------------------------------------------------------------

function handleRun(req, res) {
  readJsonBody(req)
    .then(({ command, url, acceptSelfSigned, forms }) => {
      // Validate required fields
      if (!command || typeof command !== 'string') {
        sendError(res, 400, '"command" (string) is required');
        return;
      }
      if (!url || typeof url !== 'string') {
        sendError(res, 400, '"url" (string) is required');
        return;
      }

      // If forms array provided, append "-- form1 form2" for selective upload
      // cht-conf syntax: cht convert-app-forms upload-app-forms -- form1 form2
      let formsSuffix = '';
      if (Array.isArray(forms) && forms.length > 0) {
        formsSuffix = ' -- ' + forms.join(' ');
      }

      // Switch to SSE
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx buffering if present
      });

      /**
       * Emit one SSE event.  We never include the url/credentials in the
       * emitted data — only stdout/stderr text from the cht process and the
       * exit code.
       */
      function emit(type, text) {
        const payload = JSON.stringify({ type, text });
        res.write(`data: ${payload}\n\n`);
      }

      const args = buildChtArgs(url, acceptSelfSigned, command, forms);

      // Spawn cht-conf.  We do NOT use { shell: true } to avoid shell injection.
      const proc = spawn('cht', args, {
        cwd:   process.cwd(),
        env:   process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      // Stream stdout line by line
      proc.stdout.on('data', (chunk) => {
        // A single 'data' event may contain multiple lines
        chunk.split('\n').forEach((line) => {
          if (line) emit('stdout', line);
        });
      });

      // Stream stderr line by line
      proc.stderr.on('data', (chunk) => {
        chunk.split('\n').forEach((line) => {
          if (line) emit('stderr', line);
        });
      });

      proc.on('error', (err) => {
        // Likely means 'cht' was not found on PATH
        emit('stderr', `Failed to start cht: ${err.message}`);
        emit('exit', null);
        res.end();
      });

      proc.on('close', (code) => {
        const payload = JSON.stringify({ type: 'exit', code });
        res.write(`data: ${payload}\n\n`);
        res.end();
      });

      // If the client disconnects, kill the child process
      req.on('close', () => {
        proc.kill();
      });
    })
    .catch((err) => {
      sendError(res, 400, err.message);
    });
}

// ---------------------------------------------------------------------------
// Route: POST /api/test-connection
// ---------------------------------------------------------------------------

function handleTestConnection(req, res) {
  readJsonBody(req)
    .then(({ url, acceptSelfSigned }) => {
      if (!url || typeof url !== 'string') {
        sendError(res, 400, '"url" (string) is required');
        return;
      }

      const args = buildChtArgs(url, acceptSelfSigned, 'fetch-forms-from-server');

      let stderr = '';
      const proc = spawn('cht', args, {
        cwd:   process.cwd(),
        env:   process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => { stderr += chunk; });

      // We only care about the exit code
      proc.stdout.resume(); // drain stdout without storing

      proc.on('error', (err) => {
        sendJson(res, 200, { ok: false, error: `Failed to start cht: ${err.message}` });
      });

      proc.on('close', (code) => {
        if (code === 0) {
          sendJson(res, 200, { ok: true });
        } else {
          // Surface the last meaningful line from stderr, but strip any
          // credential-looking patterns before returning to the client.
          const safeError = (stderr.trim().split('\n').pop() || 'Non-zero exit code')
            .replace(/\/\/[^@]*@/g, '//<credentials>@'); // redact user:pass in URLs
          sendJson(res, 200, { ok: false, error: safeError });
        }
      });
    })
    .catch((err) => {
      sendError(res, 400, err.message);
    });
}

// ---------------------------------------------------------------------------
// Main request dispatcher
// ---------------------------------------------------------------------------

function requestHandler(req, res) {
  resetInactivityTimer();
  setCorsHeaders(req, res);

  const { method, url } = req;

  // Handle pre-flight CORS requests
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Strip query string for routing
  const pathname = url.split('?')[0];

  if (method === 'GET'  && pathname === '/')                     return handleRoot(req, res);
  if (method === 'GET'  && pathname === '/api/project-info')     return handleProjectInfo(req, res);
  if (method === 'GET'  && pathname === '/api/forms')            return handleListForms(req, res);
  if (method === 'POST' && pathname === '/api/run')              return handleRun(req, res);
  if (method === 'POST' && pathname === '/api/test-connection')  return handleTestConnection(req, res);

  sendError(res, 404, `No route for ${method} ${pathname}`);
}

// ---------------------------------------------------------------------------
// Port probe — find next available port starting from PREFERRED_PORT
// ---------------------------------------------------------------------------

/**
 * Try to bind a throwaway server to the given host:port.
 * Resolves with the port if available, rejects otherwise.
 */
function probePort(host, port) {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(port, host, () => {
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Find the first available port starting at `start`.
 * Tries up to 10 consecutive ports before giving up.
 */
async function findAvailablePort(host, start, maxTries = 10) {
  for (let i = 0; i < maxTries; i++) {
    const candidate = start + i;
    try {
      await probePort(host, candidate);
      return candidate;
    } catch (_) {
      // port in use — try next
    }
  }
  throw new Error(`No available port found in range ${start}–${start + maxTries - 1}`);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  const port = await findAvailablePort(HOST, PREFERRED_PORT);

  const server = http.createServer(requestHandler);

  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`;
    console.log(`CHT Deploy server running at ${url}`);
    console.log(`Project: ${process.cwd()}`);
    console.log('Auto-shutdown in 30 minutes of inactivity');

    // Start the inactivity countdown immediately
    resetInactivityTimer();
  });

  server.on('error', (err) => {
    console.error('Server error:', err.message);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
