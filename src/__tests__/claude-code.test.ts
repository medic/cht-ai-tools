import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeCodeTarget } from '../targets/claude-code.js';

let tempDir: string;
let target: ClaudeCodeTarget;

// Override getConfigPath to use temp directory
class TestableClaudeCodeTarget extends ClaudeCodeTarget {
  constructor(private basePath: string) {
    super();
  }
  getConfigPath(_location: 'global' | 'project'): string {
    return this.basePath;
  }
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(tmpdir(), 'cht-ai-tools-test-'));
  target = new TestableClaudeCodeTarget(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('configureMcp', () => {
  it('creates mcp_config.json when it does not exist', async () => {
    await target.configureMcp(
      { name: 'test-server', type: 'http', url: 'https://example.com/mcp' },
      'global'
    );

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'mcp_config.json'), 'utf-8')
    );
    expect(content.mcpServers['test-server']).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
    });
  });

  it('merges into existing mcp_config.json preserving other servers', async () => {
    const existing = {
      mcpServers: {
        'existing-server': { type: 'http', url: 'https://existing.com/mcp' },
      },
    };
    await fs.writeFile(
      path.join(tempDir, 'mcp_config.json'),
      JSON.stringify(existing),
      'utf-8'
    );

    await target.configureMcp(
      { name: 'new-server', type: 'http', url: 'https://new.com/mcp' },
      'global'
    );

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'mcp_config.json'), 'utf-8')
    );
    expect(content.mcpServers['existing-server']).toEqual({
      type: 'http',
      url: 'https://existing.com/mcp',
    });
    expect(content.mcpServers['new-server']).toEqual({
      type: 'http',
      url: 'https://new.com/mcp',
    });
  });

  it('preserves extra top-level keys in mcp_config.json', async () => {
    const existing = {
      mcpServers: {},
      customSetting: 'keep-me',
    };
    await fs.writeFile(
      path.join(tempDir, 'mcp_config.json'),
      JSON.stringify(existing),
      'utf-8'
    );

    await target.configureMcp(
      { name: 'test', type: 'http', url: 'https://test.com' },
      'global'
    );

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'mcp_config.json'), 'utf-8')
    );
    expect(content.customSetting).toBe('keep-me');
  });

  it('throws on invalid JSON in mcp_config.json', async () => {
    await fs.writeFile(
      path.join(tempDir, 'mcp_config.json'),
      '{ broken json',
      'utf-8'
    );

    await expect(
      target.configureMcp(
        { name: 'test', type: 'http', url: 'https://test.com' },
        'global'
      )
    ).rejects.toThrow(/Invalid JSON/);
  });

  it('configures stdio server with command and args', async () => {
    await target.configureMcp(
      { name: 'local', type: 'stdio', command: 'npx', args: ['-y', '@org/server'] },
      'global'
    );

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'mcp_config.json'), 'utf-8')
    );
    expect(content.mcpServers['local']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@org/server'],
    });
  });
});

describe('configureHook', () => {
  const testHook = {
    event: 'PreToolUse' as const,
    matcher: 'Bash',
    scriptName: 'test-hook.sh',
    sourcePath: '', // Will be set in beforeEach
  };

  beforeEach(async () => {
    // Create a source hook script
    const sourceDir = path.join(tempDir, 'source');
    await fs.mkdir(sourceDir, { recursive: true });
    const sourceScript = path.join(sourceDir, 'test-hook.sh');
    await fs.writeFile(sourceScript, '#!/bin/bash\nexit 0\n', 'utf-8');
    testHook.sourcePath = sourceScript;
  });

  it('creates settings.json when it does not exist', async () => {
    await target.configureHook(testHook, 'global');

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'settings.json'), 'utf-8')
    );
    expect(content.hooks.PreToolUse).toHaveLength(1);
    expect(content.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(content.hooks.PreToolUse[0].hooks[0].command).toContain('test-hook.sh');
  });

  it('merges into existing settings.json preserving other hooks', async () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'bash other.sh' }],
          },
        ],
      },
    };
    await fs.writeFile(
      path.join(tempDir, 'settings.json'),
      JSON.stringify(existing),
      'utf-8'
    );

    await target.configureHook(testHook, 'global');

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'settings.json'), 'utf-8')
    );
    expect(content.hooks.PreToolUse).toHaveLength(2);
    expect(content.hooks.PreToolUse[0].matcher).toBe('Write');
    expect(content.hooks.PreToolUse[1].matcher).toBe('Bash');
  });

  it('replaces existing hook with same matcher, preserving other hooks in that matcher', async () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'bash user-hook.sh' },
              { type: 'command', command: 'bash test-hook.sh' },
            ],
          },
        ],
      },
    };
    await fs.writeFile(
      path.join(tempDir, 'settings.json'),
      JSON.stringify(existing),
      'utf-8'
    );

    await target.configureHook(testHook, 'global');

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'settings.json'), 'utf-8')
    );
    expect(content.hooks.PreToolUse).toHaveLength(1);
    const bashMatcher = content.hooks.PreToolUse[0];
    expect(bashMatcher.hooks).toHaveLength(2);
    // User hook preserved, our hook updated
    expect(bashMatcher.hooks[0].command).toBe('bash user-hook.sh');
    expect(bashMatcher.hooks[1].command).toContain('test-hook.sh');
  });

  it('preserves extra top-level keys in settings.json', async () => {
    const existing = {
      hooks: {},
      permissions: { allow: ['Read'] },
    };
    await fs.writeFile(
      path.join(tempDir, 'settings.json'),
      JSON.stringify(existing),
      'utf-8'
    );

    await target.configureHook(testHook, 'global');

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'settings.json'), 'utf-8')
    );
    expect(content.permissions).toEqual({ allow: ['Read'] });
  });

  it('throws on invalid JSON in settings.json', async () => {
    await fs.writeFile(
      path.join(tempDir, 'settings.json'),
      'not json',
      'utf-8'
    );

    await expect(target.configureHook(testHook, 'global')).rejects.toThrow(
      /Invalid JSON/
    );
  });

  it('copies hook script and makes it executable', async () => {
    await target.configureHook(testHook, 'global');

    const installedScript = path.join(tempDir, 'hooks', 'test-hook.sh');
    const stat = await fs.stat(installedScript);
    expect(stat.isFile()).toBe(true);
    // Check executable bit (owner execute = 0o100)
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('uses relative path for project-location hooks', async () => {
    await target.configureHook(testHook, 'project');

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'settings.json'), 'utf-8')
    );
    const command = content.hooks.PreToolUse[0].hooks[0].command;
    expect(command).toBe('bash .claude/hooks/test-hook.sh');
  });
});

describe('installSkill', () => {
  let skillSourceDir: string;

  beforeEach(async () => {
    skillSourceDir = path.join(tempDir, 'source-skill');
    await fs.mkdir(skillSourceDir, { recursive: true });
    await fs.writeFile(path.join(skillSourceDir, 'SKILL.md'), '# Test Skill\n');
  });

  it('copies skill directory', async () => {
    await target.installSkill(
      { name: 'test-skill', sourcePath: skillSourceDir },
      'global'
    );

    const installed = path.join(tempDir, 'skills', 'test-skill', 'SKILL.md');
    const content = await fs.readFile(installed, 'utf-8');
    expect(content).toBe('# Test Skill\n');
  });

  it('throws when skill exists and overwrite is false', async () => {
    await target.installSkill(
      { name: 'test-skill', sourcePath: skillSourceDir },
      'global',
      { overwrite: true }
    );

    await expect(
      target.installSkill(
        { name: 'test-skill', sourcePath: skillSourceDir },
        'global',
        { overwrite: false }
      )
    ).rejects.toThrow(/already exists/);
  });

  it('replaces skill when overwrite is true', async () => {
    await target.installSkill(
      { name: 'test-skill', sourcePath: skillSourceDir },
      'global',
      { overwrite: true }
    );

    // Modify source
    await fs.writeFile(path.join(skillSourceDir, 'SKILL.md'), '# Updated\n');

    await target.installSkill(
      { name: 'test-skill', sourcePath: skillSourceDir },
      'global',
      { overwrite: true }
    );

    const content = await fs.readFile(
      path.join(tempDir, 'skills', 'test-skill', 'SKILL.md'),
      'utf-8'
    );
    expect(content).toBe('# Updated\n');
  });
});

describe('installCommand', () => {
  let cmdSourcePath: string;

  beforeEach(async () => {
    const sourceDir = path.join(tempDir, 'source-cmds');
    await fs.mkdir(sourceDir, { recursive: true });
    cmdSourcePath = path.join(sourceDir, 'test-cmd.md');
    await fs.writeFile(cmdSourcePath, '# Test Command\n');
  });

  it('copies command file', async () => {
    await target.installCommand(
      { name: 'test-cmd', sourcePath: cmdSourcePath },
      'global'
    );

    const installed = path.join(tempDir, 'commands', 'test-cmd.md');
    const content = await fs.readFile(installed, 'utf-8');
    expect(content).toBe('# Test Command\n');
  });

  it('throws when command exists and overwrite is false', async () => {
    await target.installCommand(
      { name: 'test-cmd', sourcePath: cmdSourcePath },
      'global',
      { overwrite: true }
    );

    await expect(
      target.installCommand(
        { name: 'test-cmd', sourcePath: cmdSourcePath },
        'global',
        { overwrite: false }
      )
    ).rejects.toThrow(/already exists/);
  });
});
