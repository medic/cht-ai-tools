const { createReplayLookup, shortToolName } = require('../../../src/agent/tools/replay-shim');
const { argsHash } = require('../../../src/agent/tools/args-hash');

describe('agent/tools/replay-shim', () => {
  it('strips the mcp__<server>__ prefix from recorded tool names', () => {
    expect(shortToolName('mcp__watchdog__get_windows')).to.deep.equal({ server: 'watchdog', tool: 'get_windows' });
    expect(shortToolName('mcp__cht-docs__search_docs')).to.deep.equal({ server: 'cht-docs', tool: 'search_docs' });
    expect(shortToolName('get_windows')).to.deep.equal({ server: null, tool: 'get_windows' });
  });

  it('serves recordings written by the session loop (tool_name, tool_input, JSON text tool_response)', () => {
    const records = [{
      pass: 1, attempt: 1, ts: '2026-09-18T06:01:00Z',
      tool_name: 'mcp__watchdog__get_windows', tool_input: { metric: 'cht_sentinel_backlog_count' },
      tool_response: JSON.stringify({ windows: [{ window: 'current' }], change: { current_value: 912 } }),
    }];
    const lookup = createReplayLookup(records);
    const hash = argsHash({ metric: 'cht_sentinel_backlog_count' });
    expect(lookup.size).to.equal(1);
    expect(lookup.lookup('get_windows', hash)).to.deep.equal({
      windows: [{ window: 'current' }], change: { current_value: 912 },
    });
    expect(lookup.lookup('mcp__watchdog__get_windows', hash)).to.deep.equal(lookup.lookup('get_windows', hash));
    expect(lookup.lookup('get_windows', argsHash({ metric: 'other' }))).to.equal(undefined);
  });

  it('keeps non-JSON responses as text and still accepts the older tool/args/result record shape', () => {
    const lookup = createReplayLookup([
      { tool_name: 'mcp__cht-docs__search_docs', tool_input: { query: 'sentinel' }, tool_response: '**Doc**\nSource: https://docs.communityhealthtoolkit.org/x' },
      { tool: 'get_windows', args: { metric: 'm' }, result: { recorded: true } },
    ]);
    expect(lookup.lookup('search_docs', argsHash({ query: 'sentinel' }))).to.include('Source: https://docs');
    expect(lookup.lookup('get_windows', argsHash({ metric: 'm' }))).to.deep.equal({ recorded: true });
  });

  it('scopes a lookup to one server when asked', () => {
    const lookup = createReplayLookup([
      { tool_name: 'mcp__watchdog__get_windows', tool_input: { metric: 'm' }, tool_response: '{"a":1}' },
      { tool_name: 'mcp__cht-docs__get_sources', tool_input: {}, tool_response: '- scrape: Documentation' },
    ]);
    const docs = lookup.forServer('cht-docs');
    expect(docs.size).to.equal(1);
    expect(docs.lookup('get_sources', argsHash({}))).to.equal('- scrape: Documentation');
    expect(docs.lookup('get_windows', argsHash({ metric: 'm' }))).to.equal(undefined);
  });

  it('counts the calls it could not answer', () => {
    const lookup = createReplayLookup([]);
    expect(lookup.lookup('get_windows', argsHash({ metric: 'm' }))).to.equal(undefined);
    expect(lookup.lookup('get_windows', argsHash({ metric: 'n' }))).to.equal(undefined);
    expect(lookup.misses).to.equal(2);
  });
});
