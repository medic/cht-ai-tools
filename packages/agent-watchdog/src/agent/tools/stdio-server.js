'use strict';
// The local read-only tools served over an MCP transport to the `claude` command-line engine
// (contracts/agent-definition.md). Import paths verified against @modelcontextprotocol/sdk 1.30.0 (dist/cjs):
// server/mcp.js exports McpServer (registerTool with a zod raw shape, zod 4 supported), server/stdio.js exports
// StdioServerTransport. Nothing here writes to stdout except the transport.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

/**
 * @param {object} options
 * @param {string} [options.name] MCP server name (the `mcp__<name>__` prefix the model sees)
 * @param {string} [options.version]
 * @param {object[]} options.tools tool definitions ({ name, description, schema, handler })
 * @returns {{ server: McpServer, connect: Function }}
 */
const createStdioToolServer = ({ name = 'watchdog', version = '1.0.0', tools }) => {
  const server = new McpServer({ name, version });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      // With an empty input shape the SDK may hand the callback only its extra argument.
      async (args, extra) => tool.handler(extra === undefined ? {} : args),
    );
  }
  return { server, connect: (transport) => server.connect(transport) };
};

/** Serve on the process's stdio; resolves when the client closes the transport. */
const serveStdio = async (options) => {
  const { server } = createStdioToolServer(options);
  const closed = new Promise((resolve) => {
    server.server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport());
  return closed;
};

module.exports = { createStdioToolServer, serveStdio };
