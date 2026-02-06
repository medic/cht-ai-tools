import type { Target, Hook } from '../targets/base.js';
import { getAssetPath } from './common.js';

export const CHT_HOOKS: Hook[] = [
  {
    event: 'PreToolUse',
    matcher: 'Bash',
    scriptName: 'validate-cht.sh',
    sourcePath: getAssetPath('hooks/validate-cht.sh'),
  },
  {
    event: 'PostToolUse',
    matcher: 'Write',
    scriptName: 'format-cht.sh',
    sourcePath: getAssetPath('hooks/format-cht.sh'),
  },
];

export async function installHooks(
  target: Target,
  location: 'global' | 'project',
  hookNames: string[]
): Promise<void> {
  const hooks = CHT_HOOKS.filter(h => hookNames.includes(h.scriptName.replace('.sh', '')));
  for (const hook of hooks) {
    await target.configureHook(hook, location);
  }
}
