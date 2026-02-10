#!/usr/bin/env node
import { runInstall } from './cli/install.js';

const args = process.argv.slice(2);

declare const __VERSION__: string;

if (args.includes('--version')) {
  console.log(__VERSION__);
  process.exit(0);
}

// Parse --target <name> or --target=<name>
function parseTargetValue(): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i].startsWith('--target=')) {
      return args[i].slice('--target='.length);
    }
  }
  return undefined;
}

const target = parseTargetValue();

// Find the command, skipping flags and the --target value
const command = args.find((a, i) => {
  if (a.startsWith('-')) return false;
  // Skip if this arg is the value of --target
  if (i > 0 && args[i - 1] === '--target') return false;
  return true;
});

if (args.includes('--help') || args.includes('-h') || !command) {
  console.log(`
  CHT AI Tools - Install CHT tools into Claude Code or OpenCode

  Usage:
    npx @medic/cht-ai-tools install [options]

  Commands:
    install         Install CHT tools into Claude Code or OpenCode

  Options:
    --target <name>  Target platform: claude-code, opencode (auto-detected if omitted)
    --skills      Install skills only
    --mcp         Install MCP servers only
    --commands    Install slash commands only
    --hooks       Install hooks only (Claude Code only)
    --all, --yes, -y  Install all components (non-interactive)
    --project     Install to project directory instead of global config
    --help, -h    Show this help message
    --version     Show version number

  Examples:
    npx @medic/cht-ai-tools install              # Interactive mode (auto-detect target)
    npx @medic/cht-ai-tools install --all        # Install everything
    npx @medic/cht-ai-tools install --target opencode --all
    npx @medic/cht-ai-tools install --skills --mcp --project
`);
  process.exit(0);
}

if (command !== 'install') {
  console.error(`Unknown command: ${command}\nRun with --help for usage information.`);
  process.exit(1);
}

// Parse flags
const hasFlag = (flag: string) => args.includes(flag);

runInstall({
  installAll: hasFlag('--all') || hasFlag('--yes') || hasFlag('-y'),
  skills: hasFlag('--skills'),
  mcp: hasFlag('--mcp'),
  commands: hasFlag('--commands'),
  hooks: hasFlag('--hooks'),
  project: hasFlag('--project'),
  target,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
