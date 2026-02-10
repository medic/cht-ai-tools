import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  promptInstallLocation,
  promptItems,
  promptTargetSelection,
  allItems,
  type InstallLocation,
  type SelectionResult,
} from './prompts.js';
import { ensureDir } from './utils.js';
import type { Target } from '../targets/base.js';
import { ClaudeCodeTarget } from '../targets/claude-code.js';
import { getTargetByName, detectTargets, allTargetNames } from '../targets/registry.js';
import {
  installSkills,
  installMcp,
  installCommands,
  installHooks,
} from '../installers/index.js';

const TARGET_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'opencode': 'OpenCode',
};

function getTargetDisplayName(target: Target): string {
  return TARGET_DISPLAY_NAMES[target.name] ?? target.name;
}

function getDisplayPath(target: Target, location: InstallLocation): string {
  if (target.name === 'opencode') {
    return location === 'global' ? '~/.config/opencode/' : './.opencode/';
  }
  return location === 'global' ? '~/.claude/' : './.claude/';
}

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
  target: Target,
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

/**
 * Resolve the target to use based on --target flag or auto-detection.
 */
async function resolveTarget(
  targetName: string | undefined,
  nonInteractive: boolean
): Promise<Target> {
  // Explicit --target flag
  if (targetName) {
    const target = getTargetByName(targetName);
    if (!target) {
      const known = allTargetNames().join(', ');
      throw new Error(`Unknown target: '${targetName}'. Known targets: ${known}`);
    }
    return target;
  }

  // Auto-detect
  const detected = await detectTargets();

  if (detected.length === 1) {
    return detected[0];
  }

  if (detected.length > 1) {
    if (nonInteractive) {
      const names = detected.map(t => t.name).join(', ');
      throw new Error(
        `Multiple targets detected (${names}). Use --target <name> to specify which one.`
      );
    }
    return promptTargetSelection(detected);
  }

  // Nothing detected — default to Claude Code with warning
  p.log.warn(
    'No supported target detected. Defaulting to Claude Code.'
  );
  return new ClaudeCodeTarget();
}

export interface InstallOptions {
  installAll?: boolean;
  skills?: boolean;
  mcp?: boolean;
  commands?: boolean;
  hooks?: boolean;
  project?: boolean;
  target?: string;
}

/**
 * Main install command entry point
 */
export async function runInstall(options: InstallOptions = {}): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' CHT AI Tools ')));

  const isNonInteractive = (options.installAll || options.skills || options.mcp || options.commands || options.hooks) ?? false;
  const target = await resolveTarget(options.target, isNonInteractive);
  const displayName = getTargetDisplayName(target);
  const supportsHooks = target.name !== 'opencode';

  p.log.info(
    `Install CHT-specific skills, MCP servers, and tools into ${pc.cyan(displayName)}`
  );

  // Determine if component flags were passed
  const hasComponentFlags = options.skills || options.mcp || options.commands || options.hooks;

  let location: InstallLocation;
  let selection: SelectionResult;

  if (isNonInteractive) {
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

    // Filter out hooks if target doesn't support them
    if (!supportsHooks && selection.hooks.length > 0) {
      p.log.warn(`${displayName} does not support hooks. Skipping hook installation.`);
      selection.hooks = [];
    }

    const displayPath = getDisplayPath(target, location);
    p.log.step(`Installing ${formatSelection(selection)} to ${pc.cyan(displayPath)}`);
  } else {
    // Interactive mode (no flags passed)
    location = await promptInstallLocation(target);

    const displayPath = getDisplayPath(target, location);
    p.log.step(
      `Installing to ${pc.cyan(displayPath)}`
    );

    selection = await promptItems(target);

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
      pc.dim(`  Restart ${displayName} to use CHT tools.`)
  );
}
