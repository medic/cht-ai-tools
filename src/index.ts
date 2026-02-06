#!/usr/bin/env node
import { runInit } from './cli/init.js';

const args = process.argv.slice(2);

declare const __VERSION__: string;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  CHT AI Tools - Install CHT tools into Claude Code

  Usage:
    npx @medic/cht-ai-tools init [options]

  Options:
    --yes, -y     Install all components to global location (non-interactive)
    --help, -h    Show this help message
    --version     Show version number
`);
  process.exit(0);
}

if (args.includes('--version')) {
  console.log(__VERSION__);
  process.exit(0);
}

const nonInteractive = args.includes('--yes') || args.includes('-y');

runInit({ nonInteractive }).catch((err) => {
  console.error(err);
  process.exit(1);
});
