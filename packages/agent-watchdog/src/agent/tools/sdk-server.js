'use strict';
// The watchdog tools as an in-process MCP server for the SDK engine.
const createSdkToolServer = (sdk, tools, { name = 'watchdog', version = '1.0.0' } = {}) => sdk.createSdkMcpServer({
  name,
  version,
  tools: tools.map((t) => sdk.tool(t.name, t.description, t.schema, t.handler)),
});

module.exports = { createSdkToolServer };
