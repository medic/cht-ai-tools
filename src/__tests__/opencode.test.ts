import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeTarget } from '../targets/opencode.js';

let tempDir: string;
let target: OpenCodeTarget;

/**
 * Testable subclass that overrides config paths to use a temp directory.
 * getConfigPath → tempDir (for skills/commands)
 * getOpenCodeConfigPath → tempDir/opencode.json (for MCP config)
 */
class TestableOpenCodeTarget extends OpenCodeTarget {
  constructor(private basePath: string) {
    super();
  }
  getConfigPath(_location: 'global' | 'project'): string {
    return this.basePath;
  }
  protected getOpenCodeConfigPath(_location: 'global' | 'project'): string {
    return path.join(this.basePath, 'opencode.json');
  }
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(tmpdir(), 'cht-opencode-test-'));
  target = new TestableOpenCodeTarget(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('configureMcp', () => {
  it('creates opencode.json when it does not exist', async () => {
    await target.configureMcp(
      { name: 'cht-docs', type: 'http', url: 'https://example.com/mcp' },
      'global'
    );

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'opencode.json'), 'utf-8')
    );
    expect(content.mcp['cht-docs']).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      enabled: true,
    });
  });

  it('maps http type to remote', async () => {
    await target.configureMcp(
      { name: 'test', type: 'http', url: 'https://test.com' },
      'global'
    );

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'opencode.json'), 'utf-8')
    );
    expect(content.mcp['test'].type).toBe('remote');
  });

  it('maps stdio type to local with merged command array', async () => {
    await target.configureMcp(
      { name: 'local-server', type: 'stdio', command: 'npx', args: ['-y', '@org/server'] },
      'global'
    );

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'opencode.json'), 'utf-8')
    );
    expect(content.mcp['local-server']).toEqual({
      type: 'local',
      command: ['npx', '-y', '@org/server'],
      enabled: true,
    });
  });

  it('preserves other top-level keys in opencode.json', async () => {
    const existing = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      theme: 'dark',
    };
    await fs.writeFile(
      path.join(tempDir, 'opencode.json'),
      JSON.stringify(existing),
      'utf-8'
    );

    await target.configureMcp(
      { name: 'test', type: 'http', url: 'https://test.com' },
      'global'
    );

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'opencode.json'), 'utf-8')
    );
    expect(content.provider).toBe('anthropic');
    expect(content.model).toBe('claude-sonnet-4-5-20250929');
    expect(content.theme).toBe('dark');
    expect(content.mcp['test']).toBeDefined();
  });

  it('merges with existing MCP servers', async () => {
    const existing = {
      mcp: {
        'existing-server': { type: 'remote', url: 'https://existing.com', enabled: true },
      },
    };
    await fs.writeFile(
      path.join(tempDir, 'opencode.json'),
      JSON.stringify(existing),
      'utf-8'
    );

    await target.configureMcp(
      { name: 'new-server', type: 'http', url: 'https://new.com' },
      'global'
    );

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'opencode.json'), 'utf-8')
    );
    expect(content.mcp['existing-server']).toEqual({
      type: 'remote',
      url: 'https://existing.com',
      enabled: true,
    });
    expect(content.mcp['new-server']).toEqual({
      type: 'remote',
      url: 'https://new.com',
      enabled: true,
    });
  });

  it('throws on invalid JSON in opencode.json', async () => {
    await fs.writeFile(
      path.join(tempDir, 'opencode.json'),
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

  it('sets enabled: true on all MCP entries', async () => {
    await target.configureMcp(
      { name: 'test', type: 'http', url: 'https://test.com' },
      'global'
    );

    const content = JSON.parse(
      await fs.readFile(path.join(tempDir, 'opencode.json'), 'utf-8')
    );
    expect(content.mcp['test'].enabled).toBe(true);
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

describe('configureHook', () => {
  it('does not throw', async () => {
    await expect(
      target.configureHook(
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          scriptName: 'validate-cht.sh',
          sourcePath: '/fake/path/validate-cht.sh',
        },
        'global'
      )
    ).resolves.toBeUndefined();
  });

  it('does not create any files', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await target.configureHook(
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        scriptName: 'validate-cht.sh',
        sourcePath: '/fake/path/validate-cht.sh',
      },
      'global'
    );

    // Only the temp dir should exist, no hooks/ or settings files created
    const entries = await fs.readdir(tempDir);
    expect(entries).not.toContain('hooks');
    expect(entries).not.toContain('settings.json');

    warnSpy.mockRestore();
  });

  it('logs a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await target.configureHook(
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        scriptName: 'validate-cht.sh',
        sourcePath: '/fake/path/validate-cht.sh',
      },
      'global'
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('does not support hooks')
    );

    warnSpy.mockRestore();
  });
});
