/**
 * Claude Code target implementation.
 * Handles installation of skills, MCP servers, commands, and hooks
 * for the Claude Code CLI.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Target, Skill, McpServer, Command, Hook, InstallOptions } from './base.js';

interface McpServerEntry {
  type?: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

interface HookCommand {
  type: 'command';
  command: string;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

interface SettingsConfig {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

export class ClaudeCodeTarget implements Target {
  readonly name = 'claude-code';

  /**
   * Check if Claude Code is installed by looking for ~/.claude directory
   * or checking if the claude CLI binary is available in PATH.
   */
  async detect(): Promise<boolean> {
    // Check if ~/.claude directory exists
    const claudeDir = path.join(homedir(), '.claude');
    try {
      const stat = await fs.stat(claudeDir);
      if (stat.isDirectory()) return true;
    } catch { }

    // Check if claude CLI is in PATH
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('claude', ['--version']);
      return true;
    } catch { }

    return false;
  }

  /**
   * Get the configuration directory path.
   * - global: ~/.claude/
   * - project: ./.claude/
   */
  getConfigPath(location: 'global' | 'project'): string {
    if (location === 'global') {
      return path.join(homedir(), '.claude');
    }
    return path.join(process.cwd(), '.claude');
  }

  /**
   * Install a skill by copying the skill directory to [config]/skills/[name]/
   */
  async installSkill(
    skill: Skill,
    location: 'global' | 'project',
    options: InstallOptions = {}
  ): Promise<void> {
    const configPath = this.getConfigPath(location);
    const skillsDir = path.join(configPath, 'skills');
    const targetDir = path.join(skillsDir, skill.name);

    // Check if skill already exists
    const exists = await this.pathExists(targetDir);
    if (exists && !options.overwrite) {
      throw new Error(`Skill '${skill.name}' already exists at ${targetDir}. Use overwrite option to replace.`);
    }

    // Create skills directory if needed
    await fs.mkdir(skillsDir, { recursive: true });

    // Remove existing if overwriting
    if (exists && options.overwrite) {
      await fs.rm(targetDir, { recursive: true, force: true });
    }

    // Copy skill directory
    await fs.cp(skill.sourcePath, targetDir, { recursive: true });
  }

  /**
   * Configure an MCP server by updating [config]/mcp_config.json
   */
  async configureMcp(server: McpServer, location: 'global' | 'project'): Promise<void> {
    const configPath = this.getConfigPath(location);
    const mcpConfigPath = path.join(configPath, 'mcp_config.json');

    // Ensure config directory exists
    await fs.mkdir(configPath, { recursive: true });

    // Read existing config or create empty one
    let config: McpConfig = { mcpServers: {} };
    try {
      const content = await fs.readFile(mcpConfigPath, 'utf-8');
      config = JSON.parse(content) as McpConfig;
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
    } catch {
      // File doesn't exist, use default empty config
    }

    // Build server entry based on type
    const serverEntry: McpServerEntry = {
      type: server.type,
    };

    if (server.type === 'http' && server.url) {
      serverEntry.url = server.url;
    } else if (server.type === 'stdio') {
      if (server.command) {
        serverEntry.command = server.command;
      }
      if (server.args && server.args.length > 0) {
        serverEntry.args = server.args;
      }
    }

    // Merge new server into config
    config.mcpServers![server.name] = serverEntry;

    // Write updated config
    await fs.writeFile(mcpConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }

  /**
   * Install a command by copying the .md file to [config]/commands/
   */
  async installCommand(
    cmd: Command,
    location: 'global' | 'project',
    options: InstallOptions = {}
  ): Promise<void> {
    const configPath = this.getConfigPath(location);
    const commandsDir = path.join(configPath, 'commands');
    const targetPath = path.join(commandsDir, `${cmd.name}.md`);

    // Check if command already exists
    const exists = await this.pathExists(targetPath);
    if (exists && !options.overwrite) {
      throw new Error(`Command '${cmd.name}' already exists at ${targetPath}. Use overwrite option to replace.`);
    }

    // Create commands directory if needed
    await fs.mkdir(commandsDir, { recursive: true });

    // Copy command file
    await fs.copyFile(cmd.sourcePath, targetPath);
  }

  /**
   * Configure a hook by copying the script to config dir and updating [config]/settings.json
   */
  async configureHook(hook: Hook, location: 'global' | 'project'): Promise<void> {
    const configPath = this.getConfigPath(location);
    const hooksDir = path.join(configPath, 'hooks');
    const installedScript = path.join(hooksDir, hook.scriptName);

    // Copy hook script to config directory
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.copyFile(hook.sourcePath, installedScript);
    await fs.chmod(installedScript, 0o755);

    // Read existing settings
    const settingsPath = path.join(configPath, 'settings.json');
    let settings: SettingsConfig = { hooks: {} };
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(content) as SettingsConfig;
      if (!settings.hooks) settings.hooks = {};
    } catch { }

    const hookCommand: HookCommand = {
      type: 'command',
      command: `bash ${installedScript}`,
    };

    const eventHooks = settings.hooks![hook.event] ?? [];

    // Find existing matcher entry for this event
    const existingIndex = eventHooks.findIndex(
      (h) => (h.matcher ?? undefined) === (hook.matcher ?? undefined)
    );

    const matcherEntry: HookMatcher = {
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      hooks: [hookCommand],
    };

    if (existingIndex >= 0) {
      // Merge: replace only our command, keep other hooks in this matcher
      const existing = eventHooks[existingIndex];
      const otherHooks = existing.hooks.filter(
        (h) => !h.command.includes(hook.scriptName)
      );
      matcherEntry.hooks = [...otherHooks, hookCommand];
      eventHooks[existingIndex] = matcherEntry;
    } else {
      eventHooks.push(matcherEntry);
    }

    settings.hooks![hook.event] = eventHooks;

    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  /**
   * Helper to check if a path exists.
   */
  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
