/**
 * OpenCode target implementation.
 * Handles installation of skills, MCP servers, and commands
 * for the OpenCode CLI. Hooks are not supported.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Target, Skill, McpServer, Command, Hook, InstallOptions } from './base.js';
import { readJsonConfig, pathExists } from './utils.js';

interface OpenCodeMcpEntry {
  type: 'remote' | 'local';
  url?: string;
  command?: string[];
  enabled: boolean;
}

interface OpenCodeConfig {
  mcp?: Record<string, OpenCodeMcpEntry>;
  [key: string]: unknown;
}

export class OpenCodeTarget implements Target {
  readonly name = 'opencode';

  /**
   * Check if OpenCode is installed by looking for ~/.config/opencode/ directory
   * or checking if the opencode CLI binary is available in PATH.
   */
  async detect(): Promise<boolean> {
    const configDir = path.join(homedir(), '.config', 'opencode');
    try {
      const stat = await fs.stat(configDir);
      if (stat.isDirectory()) return true;
    } catch { }

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('opencode', ['--version']);
      return true;
    } catch { }

    return false;
  }

  /**
   * Get the configuration directory path for skills and commands.
   * - global: ~/.config/opencode/
   * - project: ./.opencode/
   */
  getConfigPath(location: 'global' | 'project'): string {
    if (location === 'global') {
      return path.join(homedir(), '.config', 'opencode');
    }
    return path.join(process.cwd(), '.opencode');
  }

  /**
   * Get the path to opencode.json for MCP configuration.
   * This is separate from getConfigPath because MCP config lives in a different location:
   * - global: ~/.config/opencode/opencode.json
   * - project: ./opencode.json (project root, NOT inside .opencode/)
   */
  protected getOpenCodeConfigPath(location: 'global' | 'project'): string {
    if (location === 'global') {
      return path.join(homedir(), '.config', 'opencode', 'opencode.json');
    }
    return path.join(process.cwd(), 'opencode.json');
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

    const exists = await pathExists(targetDir);
    if (exists && !options.overwrite) {
      throw new Error(`Skill '${skill.name}' already exists at ${targetDir}. Use overwrite option to replace.`);
    }

    await fs.mkdir(skillsDir, { recursive: true });

    if (exists && options.overwrite) {
      await fs.rm(targetDir, { recursive: true, force: true });
    }

    await fs.cp(skill.sourcePath, targetDir, { recursive: true });
  }

  /**
   * Configure an MCP server by updating opencode.json.
   * Maps Claude Code types to OpenCode types:
   *   http → remote (with url)
   *   stdio → local (with merged command array)
   */
  async configureMcp(server: McpServer, location: 'global' | 'project'): Promise<void> {
    const configFilePath = this.getOpenCodeConfigPath(location);

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(configFilePath), { recursive: true });

    const config = await readJsonConfig<OpenCodeConfig>(configFilePath, {});
    if (!config.mcp) {
      config.mcp = {};
    }

    const entry: OpenCodeMcpEntry = {
      type: server.type === 'http' ? 'remote' : 'local',
      enabled: true,
    };

    if (server.type === 'http' && server.url) {
      entry.url = server.url;
    } else if (server.type === 'stdio') {
      const command: string[] = [];
      if (server.command) {
        command.push(server.command);
      }
      if (server.args && server.args.length > 0) {
        command.push(...server.args);
      }
      if (command.length > 0) {
        entry.command = command;
      }
    }

    config.mcp[server.name] = entry;

    await fs.writeFile(configFilePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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

    const exists = await pathExists(targetPath);
    if (exists && !options.overwrite) {
      throw new Error(`Command '${cmd.name}' already exists at ${targetPath}. Use overwrite option to replace.`);
    }

    await fs.mkdir(commandsDir, { recursive: true });

    await fs.copyFile(cmd.sourcePath, targetPath);
  }

  /**
   * Hooks are not supported by OpenCode. Logs a warning and returns.
   */
  async configureHook(_hook: Hook, _location: 'global' | 'project'): Promise<void> {
    console.warn('OpenCode does not support hooks. Skipping hook configuration.');
  }
}
