import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  promptInstallLocation,
  promptItems,
  allItems,
  type InstallLocation,
  type SelectionResult,
} from './prompts.js';
import { ensureDir } from './utils.js';
import { ClaudeCodeTarget } from '../targets/claude-code.js';
import {
  installSkills,
  installMcp,
  installCommands,
  installHooks,
} from '../installers/index.js';

/**
 * Format selection for display
 */
function formatSelection(selection: SelectionResult): string {
  const parts: string[] = [];
  if (selection.skills.length) parts.push(...selection.skills);
  if (selection.mcp.length) parts.push(...selection.mcp);
  if (selection.commands.length) parts.push(...selection.commands.map(c => `/${c}`));
  if (selection.hooks.length) parts.push(...selection.hooks);
  return parts.map(s => pc.cyan(s)).join(', ');
}

/**
 * Install selected items
 */
async function installSelectedItems(
  target: ClaudeCodeTarget,
  selection: SelectionResult,
  location: InstallLocation
): Promise<void> {
  const spinner = p.spinner();
  spinner.start('Installing components...');

  const basePath = target.getConfigPath(location);
  await ensureDir(basePath);

  const results: string[] = [];

  try {
    if (selection.skills.length) {
      await installSkills(target, location, selection.skills, { overwrite: true });
      results.push(`${pc.green('✓')} Skills: ${selection.skills.join(', ')}`);
    }

    if (selection.mcp.length) {
      await installMcp(target, location, selection.mcp);
      results.push(`${pc.green('✓')} MCP: ${selection.mcp.join(', ')}`);
    }

    if (selection.commands.length) {
      await installCommands(target, location, selection.commands, { overwrite: true });
      results.push(`${pc.green('✓')} Commands: ${selection.commands.map(c => `/${c}`).join(', ')}`);
    }

    if (selection.hooks.length) {
      await installHooks(target, location, selection.hooks);
      results.push(`${pc.green('✓')} Hooks: ${selection.hooks.join(', ')}`);
    }

    spinner.stop('Components installed');

    for (const result of results) {
      p.log.success(result);
    }
  } catch (error) {
    spinner.stop('Installation failed');
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(`Failed to install: ${pc.red(message)}`);
    throw error;
  }
}

export interface InstallOptions {
  nonInteractive?: boolean;
  skills?: boolean;
  mcp?: boolean;
  commands?: boolean;
  hooks?: boolean;
  project?: boolean;
}

/**
 * Main install command entry point
 */
export async function runInstall(options: InstallOptions = {}): Promise<void> {
  const target = new ClaudeCodeTarget();

  p.intro(pc.bgCyan(pc.black(' CHT AI Tools ')));

  p.log.info(
    `Install CHT-specific skills, MCP servers, and tools into ${pc.cyan('Claude Code')}`
  );

  // Check if Claude Code is detected
  const detected = await target.detect();
  if (!detected) {
    p.log.warn(
      `Claude Code not detected. The ${pc.cyan('~/.claude/')} directory will be created.`
    );
  }

  // Determine if component flags were passed
  const hasComponentFlags = options.skills || options.mcp || options.commands || options.hooks;

  let location: InstallLocation;
  let selection: SelectionResult;

  if (options.nonInteractive || hasComponentFlags) {
    // Non-interactive: use flags to determine what to install
    location = options.project ? 'project' : 'global';

    if (hasComponentFlags) {
      // Build selection from flags
      const all = allItems();
      selection = {
        skills: options.skills ? all.skills : [],
        mcp: options.mcp ? all.mcp : [],
        commands: options.commands ? all.commands : [],
        hooks: options.hooks ? all.hooks : [],
      };
    } else {
      // --all / --yes: install everything
      selection = allItems();
    }

    p.log.step(`Installing ${formatSelection(selection)} to ${pc.cyan(location === 'global' ? '~/.claude/' : './.claude/')}`);
  } else {
    // Interactive mode (no flags passed)
    location = await promptInstallLocation();

    p.log.step(
      `Installing to ${pc.cyan(location === 'global' ? '~/.claude/' : './.claude/')}`
    );

    selection = await promptItems();

    const totalItems =
      selection.skills.length +
      selection.mcp.length +
      selection.commands.length +
      selection.hooks.length;

    if (totalItems === 0) {
      p.cancel('No items selected.');
      process.exit(0);
    }

    p.log.step(`Selected: ${formatSelection(selection)}`);
  }

  // Install items
  await installSelectedItems(target, selection, location);

  // Show success message
  p.outro(
    pc.green('Installation complete!') +
      '\n\n' +
      pc.dim('  Restart Claude Code to use CHT tools.')
  );
}
