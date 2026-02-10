/**
 * Target registry for discovering and resolving AI tool targets.
 */

import type { Target } from './base.js';
import { ClaudeCodeTarget } from './claude-code.js';
import { OpenCodeTarget } from './opencode.js';

const ALL_TARGETS: Target[] = [
  new ClaudeCodeTarget(),
  new OpenCodeTarget(),
];

/**
 * Look up a target by its name (e.g. 'claude-code', 'opencode').
 */
export function getTargetByName(name: string): Target | undefined {
  return ALL_TARGETS.find(t => t.name === name);
}

/**
 * Run detect() on all known targets in parallel and return those available.
 */
export async function detectTargets(): Promise<Target[]> {
  const results = await Promise.all(
    ALL_TARGETS.map(async (t) => ({ target: t, detected: await t.detect() }))
  );
  return results.filter(r => r.detected).map(r => r.target);
}

/**
 * Return the names of all known targets.
 */
export function allTargetNames(): string[] {
  return ALL_TARGETS.map(t => t.name);
}
