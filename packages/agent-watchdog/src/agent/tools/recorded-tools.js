'use strict';
// The documentation-service tools answered from recordings during replay (FR-041, contracts/agent-definition.md
// "Under replay ... cht-docs is likewise replaced by recorded results"). Input shapes are the ones verified against
// the live service (research.md R-4); the handlers never contact anything.
const { z } = require('zod');
const { argsHash } = require('./args-hash');

const DOCS_TOOLS = [
  {
    name: 'search_docs',
    description: 'Search the CHT documentation, forum, issues and pull requests (replayed from recordings).',
    schema: {
      query: z.string().describe('Search query'),
      maxResults: z.number().int().optional().describe('Maximum number of results'),
    },
  },
  {
    name: 'get_sources',
    description: 'List the documentation sources the search covers (replayed from recordings).',
    schema: {},
  },
];

const UNAVAILABLE = { unavailable: true, reason: 'not recorded' };

const text = (result) => ({
  content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
});

/**
 * @param {object} options
 * @param {{ lookup: Function }} options.lookup replay lookup scoped to the documentation server
 * @param {object[]} [options.tools] tool descriptions (defaults to the two allowed cht-docs tools)
 * @param {Function} [options.recorder] receives { tool, args, result } after every call
 */
const createRecordedTools = ({ lookup, tools = DOCS_TOOLS, recorder = () => {} }) => tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  schema: tool.schema,
  handler: async (args = {}) => {
    const recorded = lookup.lookup(tool.name, argsHash(args));
    const result = recorded === undefined ? UNAVAILABLE : recorded;
    recorder({ tool: tool.name, args, result });
    return text(result);
  },
}));

module.exports = { createRecordedTools, DOCS_TOOLS, UNAVAILABLE };
