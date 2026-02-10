import type { Target, Hook } from '../targets/base.js';
import { hookDisplayName } from '../targets/base.js';
import { getAssetPath } from './common.js';

export const CHT_HOOKS: Hook[] = [
  {
    event: 'PreToolUse',
    matcher: 'Bash',
    scriptName: 'validate-cht.sh',
    sourcePath: getAssetPath('hooks/scripts/validate-cht.sh'),
  },
  {
    event: 'PostToolUse',
    matcher: 'Write',
    scriptName: 'format-cht.sh',
    sourcePath: getAssetPath('hooks/scripts/format-cht.sh'),
  },
];

export async function installHooks(
  target: Target,
  location: 'global' | 'project',
  hookNames: string[]
): Promise<void> {
  const hooks = CHT_HOOKS.filter(h => hookNames.includes(hookDisplayName(h)));
  for (const hook of hooks) {
    await target.configureHook(hook, location);
  }
}
