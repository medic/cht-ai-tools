#!/usr/bin/env node
import { runInstall } from './cli/install.js';

const args = process.argv.slice(2);

declare const __VERSION__: string;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  CHT AI Tools - Install CHT tools into Claude Code

  Usage:
    npx @medic/cht-ai-tools install [options]

  Options:
    --skills      Install skills only
    --mcp         Install MCP servers only
    --commands    Install slash commands only
    --hooks       Install hooks only
    --all, -y     Install all components (non-interactive)
    --project     Install to ./.claude/ instead of ~/.claude/
    --help, -h    Show this help message
    --version     Show version number

  Examples:
    npx @medic/cht-ai-tools install              # Interactive mode
    npx @medic/cht-ai-tools install --all        # Install everything
    npx @medic/cht-ai-tools install --skills     # Skills only
    npx @medic/cht-ai-tools install --skills --mcp --project
`);
  process.exit(0);
}

if (args.includes('--version')) {
  console.log(__VERSION__);
  process.exit(0);
}

// Parse flags
const hasFlag = (flag: string) => args.includes(flag);

runInstall({
  nonInteractive: hasFlag('--all') || hasFlag('--yes') || hasFlag('-y'),
  skills: hasFlag('--skills'),
  mcp: hasFlag('--mcp'),
  commands: hasFlag('--commands'),
  hooks: hasFlag('--hooks'),
  project: hasFlag('--project'),
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
