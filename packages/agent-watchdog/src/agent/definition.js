'use strict';
// The one agent definition both engines consume (contracts/agent-definition.md): prompts, skill, tools,
// MCP configuration and output schemas, versioned with the code and hashed into every run record.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PACKAGE_PATHS } = require('../config/schema');

const PROMPT_FILES = ['system.md', 'pass-first.md', 'pass-review.md', 'revision.md', 'rollup.md'];

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const read = (file) => fs.readFileSync(file, 'utf8');

const listFiles = (dir) => {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
};

const hashFiles = (files) => sha256(files.map((f) => `${path.basename(f)}\n${read(f)}\n`).join(''));

const VARIABLE = /\$\{([A-Z0-9_]+)\}/g;

const substitute = (value, env) => {
  if (typeof value === 'string') {
    return value.replace(VARIABLE, (_, name) => {
      const v = env[name];
      return v === undefined || v === null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, env));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, substitute(inner, env)]));
  }
  return value;
};

/** Drop an Authorization header whose token was unset, then drop an empty headers object. */
const pruneHeaders = (server) => {
  if (!server.headers) {
    return server;
  }
  const kept = Object.entries(server.headers).filter(([, v]) => !/^Bearer\s*$/.test(v) && v !== '');
  const headers = Object.fromEntries(kept);
  const { headers: ignored, ...rest } = server;
  void ignored;
  return Object.keys(headers).length ? { ...rest, headers } : rest;
};

/**
 * Load the agent definition from the package directories.
 * @param {object} [options]
 * @param {object} [options.paths] package paths (defaults to PACKAGE_PATHS)
 * @param {object} [options.env] environment used to render the MCP configuration by default
 */
const loadDefinition = ({ paths = PACKAGE_PATHS, env = process.env } = {}) => {
  const promptPath = (name) => path.join(paths.promptsDir, name);
  const prompts = Object.fromEntries(PROMPT_FILES.map((name) => [name, read(promptPath(name))]));
  const skill = read(path.join(paths.skillDir, 'SKILL.md'));
  const cardIndex = read(path.join(paths.skillDir, 'pattern-cards', 'index.md'));
  const tools = JSON.parse(read(path.join(paths.agentDir, 'tools.json')));
  const mcpTemplate = JSON.parse(read(path.join(paths.agentDir, 'mcp.template.json')));
  const outputSchemas = {
    findings: JSON.parse(read(path.join(paths.schemaDir, 'findings.schema.json'))),
    brief: JSON.parse(read(path.join(paths.schemaDir, 'brief.schema.json'))),
  };

  const renderMcpConfig = (environment = env) => {
    const rendered = substitute(mcpTemplate, environment);
    const entries = Object.entries(rendered.mcpServers).map(([name, server]) => [name, pruneHeaders(server)]);
    const servers = Object.fromEntries(entries);
    return { ...rendered, mcpServers: servers };
  };

  return {
    systemPrefix: [prompts['system.md'].trim(), skill.trim(), cardIndex.trim()].join('\n\n'),
    passFirst: prompts['pass-first.md'],
    passReview: prompts['pass-review.md'],
    revision: prompts['revision.md'],
    rollup: prompts['rollup.md'],
    tools,
    mcpTemplate,
    outputSchemas,
    paths,
    hashes: {
      // Every prompt file counts, including the ones read by other stages (feedback parsing, calibration).
      prompts_hash: hashFiles(listFiles(paths.promptsDir)),
      skill_hash: hashFiles(listFiles(paths.skillDir)),
      schema_hash: hashFiles(listFiles(paths.schemaDir)),
    },
    renderMcpConfig,
  };
};

module.exports = { loadDefinition, substitute, pruneHeaders, PROMPT_FILES };
