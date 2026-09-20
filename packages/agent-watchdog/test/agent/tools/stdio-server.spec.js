// The local tools over an MCP transport, exercised through the SDK's in-memory transport pair and client.
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { createStdioToolServer } = require('../../../src/agent/tools/stdio-server');
const { createWatchdogTools } = require('../../../src/agent/tools/watchdog-tools');
const { createRecordedTools } = require('../../../src/agent/tools/recorded-tools');
const { createReplayLookup } = require('../../../src/agent/tools/replay-shim');

const project = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };

const connect = async (tools, name) => {
  const { server } = createStdioToolServer({ name, tools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, close: () => client.close() };
};

describe('agent/tools/stdio-server', () => {
  it('lists the four watchdog tools and answers a call with the handler text', async () => {
    const deps = {
      getWindows: sinon.stub().resolves({
        windows: [{ window: 'current', values: [[1, 2]] }], change: { current_value: 2 },
      }),
      queryWindow: sinon.stub().resolves({}),
      itemHistory: sinon.stub().resolves([]),
    };
    const tools = createWatchdogTools({ deps, project, discovery: { metrics: ['cht_sentinel_backlog_count'] } });
    const { client, close } = await connect(tools, 'watchdog');
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort())
      .to.deep.equal(['get_item_history', 'get_windows', 'query_metric', 'read_pattern_card']);
    const windows = listed.tools.find((t) => t.name === 'get_windows');
    expect(windows.description).to.include('collected metric windows');
    expect(windows.inputSchema.properties).to.have.property('metric');
    const out = await client.callTool({ name: 'get_windows', arguments: { metric: 'cht_sentinel_backlog_count' } });
    expect(JSON.parse(out.content[0].text).change.current_value).to.equal(2);
    expect(deps.getWindows).to.have.been.calledWith(project, 'cht_sentinel_backlog_count');
    const unknown = await client.callTool({ name: 'get_windows', arguments: { metric: 'nope' } });
    expect(JSON.parse(unknown.content[0].text).error).to.match(/unknown metric/);
    await close();
  });

  it('serves recorded documentation tools, including the argument-less get_sources', async () => {
    const lookup = createReplayLookup([
      { tool_name: 'mcp__cht-docs__get_sources', tool_input: {}, tool_response: '- scrape: Documentation' },
      { tool_name: 'mcp__cht-docs__search_docs', tool_input: { query: 'q' }, tool_response: 'Source: https://d/x' },
    ]).forServer('cht-docs');
    const { client, close } = await connect(createRecordedTools({ lookup }), 'cht-docs');
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).to.deep.equal(['get_sources', 'search_docs']);
    const sources = await client.callTool({ name: 'get_sources', arguments: {} });
    expect(sources.content[0].text).to.equal('- scrape: Documentation');
    const search = await client.callTool({ name: 'search_docs', arguments: { query: 'q' } });
    expect(search.content[0].text).to.equal('Source: https://d/x');
    const miss = await client.callTool({ name: 'search_docs', arguments: { query: 'new' } });
    expect(JSON.parse(miss.content[0].text)).to.deep.equal({ unavailable: true, reason: 'not recorded' });
    await close();
  });
});
