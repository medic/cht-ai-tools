const { collectToolResultUrls } = require('../../src/verify/tool-urls');

describe('verify/tool-urls', () => {
  it('collects Source lines, Markdown links and bare https URLs from tool results', () => {
    const calls = [
      {
        tool: 'mcp__cht-docs__search_docs',
        output: 'text\nSource: https://docs.communityhealthtoolkit.org/a/\n---\n'
          + '[Title](https://forum.communityhealthtoolkit.org/t/1) and https://github.com/medic/cht-core/issues/1.',
      },
      { tool: 'mcp__watchdog__get_windows', output: { values: [1, 2] } },
    ];
    const urls = collectToolResultUrls(calls);
    expect([...urls].sort()).to.deep.equal([
      'https://docs.communityhealthtoolkit.org/a/',
      'https://forum.communityhealthtoolkit.org/t/1',
      'https://github.com/medic/cht-core/issues/1',
    ]);
  });

  it('accepts response or result fields and tolerates empty input', () => {
    expect(collectToolResultUrls([{ response: 'Source: https://a.example.org/x' }]).has('https://a.example.org/x')).to.equal(true);
    expect(collectToolResultUrls([]).size).to.equal(0);
    expect(collectToolResultUrls(undefined).size).to.equal(0);
  });
});

describe('verify/tool-urls: URLs are read from each text of a structured result (revision 34)', () => {
  it('reads the text leaves of a runtime tool result and never a JSON encoding of them', () => {
    const calls = [{
      tool_name: 'mcp__cht-docs__search_docs',
      tool_response: {
        content: [
          { type: 'text', text: 'See https://docs.communityhealthtoolkit.org/hosting/monitoring/\nSource: https://forum.communityhealthtoolkit.org/t/2' },
          { type: 'text', text: '[More](https://github.com/medic/cht-core/issues/9)' },
        ],
      },
    }];
    expect([...collectToolResultUrls(calls)].sort()).to.deep.equal([
      'https://docs.communityhealthtoolkit.org/hosting/monitoring/',
      'https://forum.communityhealthtoolkit.org/t/2',
      'https://github.com/medic/cht-core/issues/9',
    ]);
    // A string carrying a JSON-encoded document is still read as text: an escaped quote ends the URL.
    const encoded = collectToolResultUrls([{ output: '{"text":"Source: https://docs.communityhealthtoolkit.org/a/"}' }]);
    expect([...encoded]).to.deep.equal(['https://docs.communityhealthtoolkit.org/a/']);
  });
});
