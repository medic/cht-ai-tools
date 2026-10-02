const { createRecordedTools, DOCS_TOOLS } = require('../../../src/agent/tools/recorded-tools');
const { createReplayLookup } = require('../../../src/agent/tools/replay-shim');
const { argsHash } = require('../../../src/agent/tools/args-hash');

const parse = (out) => out.content[0].text;

describe('agent/tools/recorded-tools', () => {
  const records = [
    {
      tool_name: 'mcp__cht-docs__search_docs', tool_input: { query: 'sentinel backlog' },
      tool_response: '**Sentinel|Backlog**\nSource: https://docs.communityhealthtoolkit.org/sentinel\n---',
    },
    { tool_name: 'mcp__cht-docs__get_sources', tool_input: {}, tool_response: '- scrape: Documentation' },
  ];

  it('describes the two allowed cht-docs tools with the verified input shapes (research.md R-4)', () => {
    expect(DOCS_TOOLS.map((t) => t.name)).to.deep.equal(['search_docs', 'get_sources']);
    expect(Object.keys(DOCS_TOOLS[0].schema)).to.deep.equal(['query', 'maxResults']);
    expect(Object.keys(DOCS_TOOLS[1].schema)).to.deep.equal([]);
  });

  it('answers only from recordings and never calls anything live', async () => {
    const recorded = [];
    const tools = createRecordedTools({
      lookup: createReplayLookup(records).forServer('cht-docs'), recorder: (c) => recorded.push(c),
    });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const hit = parse(await byName.search_docs.handler({ query: 'sentinel backlog' }));
    expect(hit).to.include('Source: https://docs.communityhealthtoolkit.org/sentinel');
    const sources = parse(await byName.get_sources.handler({}));
    expect(sources).to.equal('- scrape: Documentation');
    const miss = JSON.parse(parse(await byName.search_docs.handler({ query: 'something new' })));
    expect(miss).to.deep.equal({ unavailable: true, reason: 'not recorded' });
    expect(recorded.map((c) => c.tool)).to.deep.equal(['search_docs', 'get_sources', 'search_docs']);
    expect(recorded[2].result).to.deep.equal({ unavailable: true, reason: 'not recorded' });
  });

  it('hashes maxResults into the recording key like the live call would', async () => {
    const lookup = createReplayLookup([{
      tool_name: 'mcp__cht-docs__search_docs', tool_input: { query: 'q', maxResults: 3 }, tool_response: 'three',
    }]);
    const tools = createRecordedTools({ lookup: lookup.forServer('cht-docs') });
    const search = tools.find((t) => t.name === 'search_docs');
    expect(parse(await search.handler({ query: 'q', maxResults: 3 }))).to.equal('three');
    expect(argsHash({ query: 'q', maxResults: 3 })).to.not.equal(argsHash({ query: 'q' }));
  });
});
