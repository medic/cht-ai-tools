/**
 * Base interfaces for AI tools target implementations.
 * A target represents an AI assistant platform (e.g., Claude Code)
 * that can be configured with skills, MCP servers, commands, and hooks.
 */

export interface Skill {
  name: string;
  sourcePath: string;
}

export interface McpServer {
  name: string;
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
}

export interface Command {
  name: string;
  sourcePath: string;
}

export interface Hook {
  event: 'PreToolUse' | 'PostToolUse' | 'Stop';
  matcher?: string;
  scriptName: string;    // filename like 'validate-cht.sh'
  sourcePath: string;    // absolute path to source asset
}

export interface InstallOptions {
  overwrite?: boolean;
}

export interface Target {
  name: string;

  /**
   * Detect if this target is available on the system.
   */
  detect(): Promise<boolean>;

  /**
   * Get the configuration directory path for this target.
   * @param location - 'global' for user-wide config, 'project' for current directory
   */
  getConfigPath(location: 'global' | 'project'): string;

  /**
   * Install a skill to the target's skills directory.
   * @param skill - The skill to install
   * @param location - Where to install ('global' or 'project')
   * @param options - Installation options
   */
  installSkill(skill: Skill, location: 'global' | 'project', options?: InstallOptions): Promise<void>;

  /**
   * Configure an MCP server in the target's configuration.
   * @param server - The MCP server configuration
   * @param location - Where to configure ('global' or 'project')
   */
  configureMcp(server: McpServer, location: 'global' | 'project'): Promise<void>;

  /**
   * Install a command to the target's commands directory.
   * @param cmd - The command to install
   * @param location - Where to install ('global' or 'project')
   * @param options - Installation options
   */
  installCommand(cmd: Command, location: 'global' | 'project', options?: InstallOptions): Promise<void>;

  /**
   * Configure a hook in the target's settings.
   * @param hook - The hook configuration
   * @param location - Where to configure ('global' or 'project')
   */
  configureHook(hook: Hook, location: 'global' | 'project'): Promise<void>;
}
