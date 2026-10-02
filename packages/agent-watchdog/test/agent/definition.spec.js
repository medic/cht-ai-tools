const fs = require('node:fs');
const path = require('node:path');
const { loadDefinition } = require('../../src/agent/definition');
const { PACKAGE_PATHS } = require('../../src/config/schema');

describe('agent/definition', () => {
  const env = {
    AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp',
    AGENT_WATCHDOG_DOCS_MCP_TOKEN: 'mcp-secret',
  };

  it('assembles the static prefix from system.md, SKILL.md and the pattern-card index in that order', () => {
    const definition = loadDefinition({ paths: PACKAGE_PATHS, env });
    const system = fs.readFileSync(path.join(PACKAGE_PATHS.promptsDir, 'system.md'), 'utf8').trim();
    const skill = fs.readFileSync(path.join(PACKAGE_PATHS.skillDir, 'SKILL.md'), 'utf8').trim();
    const index = fs.readFileSync(path.join(PACKAGE_PATHS.skillDir, 'pattern-cards', 'index.md'), 'utf8').trim();
    expect(definition.systemPrefix.indexOf(system)).to.equal(0);
    expect(definition.systemPrefix.indexOf(skill)).to.be.greaterThan(definition.systemPrefix.indexOf(system));
    expect(definition.systemPrefix.indexOf(index)).to.be.greaterThan(definition.systemPrefix.indexOf(skill));
  });

  it('loads the pass, revision and roll-up templates and the tool allow-list', () => {
    const definition = loadDefinition({ paths: PACKAGE_PATHS, env });
    expect(definition.passFirst).to.include('{{candidates}}');
    expect(definition.passReview).to.include('{{previous_items}}');
    expect(definition.revision).to.include('{{reasons}}');
    expect(definition.rollup).to.include('{{items}}');
    expect(definition.tools.builtins).to.deep.equal([]);
    expect(definition.tools.allowed).to.include.members([
      'mcp__cht-docs__search_docs', 'mcp__cht-docs__get_sources', 'mcp__watchdog__get_windows',
      'mcp__watchdog__query_metric', 'mcp__watchdog__read_pattern_card', 'mcp__watchdog__get_item_history',
    ]);
    expect(definition.tools.allowed).to.not.include('mcp__cht-docs__ask_question');
    expect(definition.outputSchemas.findings.$id).to.match(/findings\.schema\.json$/);
    expect(definition.outputSchemas.brief.$id).to.match(/brief\.schema\.json$/);
  });

  it('hashes prompts, skill and schemas separately and stably', () => {
    const a = loadDefinition({ paths: PACKAGE_PATHS, env }).hashes;
    const b = loadDefinition({ paths: PACKAGE_PATHS, env }).hashes;
    expect(a).to.deep.equal(b);
    for (const key of ['prompts_hash', 'skill_hash', 'schema_hash']) {
      expect(a[key]).to.match(/^[0-9a-f]{64}$/);
    }
    expect(new Set(Object.values(a)).size).to.equal(3);
  });

  it('renders the MCP config with environment values and per-tool policies', () => {
    const definition = loadDefinition({ paths: PACKAGE_PATHS, env });
    const rendered = definition.renderMcpConfig(env);
    const docs = rendered.mcpServers['cht-docs'];
    expect(docs.type).to.equal('http');
    expect(docs.url).to.equal('https://docs-mcp.example.org/mcp');
    expect(docs.headers.Authorization).to.equal('Bearer mcp-secret');
    const policy = Object.fromEntries(docs.tools.map((t) => [t.name, t.permission_policy]));
    expect(policy).to.deep.equal({
      search_docs: 'always_allow', get_sources: 'always_allow', ask_question: 'always_deny',
    });
    expect(rendered.mcpServers.watchdog.type).to.equal('sdk');
    expect(JSON.stringify(rendered)).to.not.include('${');
  });

  it('omits the Authorization header when the token is unset', () => {
    const definition = loadDefinition({ paths: PACKAGE_PATHS, env: { AGENT_WATCHDOG_DOCS_MCP_URL: 'https://d/mcp' } });
    const rendered = definition.renderMcpConfig({ AGENT_WATCHDOG_DOCS_MCP_URL: 'https://d/mcp' });
    expect(rendered.mcpServers['cht-docs'].headers).to.equal(undefined);
    expect(rendered.mcpServers['cht-docs'].url).to.equal('https://d/mcp');
  });
});
