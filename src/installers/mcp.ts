import type { Target, McpServer } from '../targets/base.js';

// NOTE: This list is also defined in .mcp.json for the plugin system.
// Keep both in sync when adding or modifying MCP servers.
export const CHT_MCP_SERVERS: McpServer[] = [
  {
    name: 'cht-docs',
    type: 'http',
    url: 'https://mcp-docs.dev.medicmobile.org/mcp',
  },
];

export async function installMcp(
  target: Target,
  location: 'global' | 'project',
  serverNames: string[]
): Promise<void> {
  const servers = CHT_MCP_SERVERS.filter(s => serverNames.includes(s.name));
  for (const server of servers) {
    await target.configureMcp(server, location);
  }
}
