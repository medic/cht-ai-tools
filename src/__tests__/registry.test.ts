import { describe, it, expect } from 'vitest';
import { getTargetByName, allTargetNames } from '../targets/registry.js';
import { ClaudeCodeTarget } from '../targets/claude-code.js';
import { OpenCodeTarget } from '../targets/opencode.js';

describe('getTargetByName', () => {
  it('returns ClaudeCodeTarget for "claude-code"', () => {
    const target = getTargetByName('claude-code');
    expect(target).toBeDefined();
    expect(target).toBeInstanceOf(ClaudeCodeTarget);
    expect(target!.name).toBe('claude-code');
  });

  it('returns OpenCodeTarget for "opencode"', () => {
    const target = getTargetByName('opencode');
    expect(target).toBeDefined();
    expect(target).toBeInstanceOf(OpenCodeTarget);
    expect(target!.name).toBe('opencode');
  });

  it('returns undefined for unknown target name', () => {
    const target = getTargetByName('unknown');
    expect(target).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    const target = getTargetByName('');
    expect(target).toBeUndefined();
  });
});

describe('allTargetNames', () => {
  it('returns both target names', () => {
    const names = allTargetNames();
    expect(names).toContain('claude-code');
    expect(names).toContain('opencode');
    expect(names).toHaveLength(2);
  });
});
