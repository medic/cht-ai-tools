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
