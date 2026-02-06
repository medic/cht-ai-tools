import type { Target, Command, InstallOptions } from '../targets/base.js';
import { getAssetPath } from './common.js';

export const CHT_COMMANDS: Command[] = [
  { name: 'cht-task', sourcePath: getAssetPath('commands/cht-task.md') },
  { name: 'cht-target', sourcePath: getAssetPath('commands/cht-target.md') },
  { name: 'cht-specialist', sourcePath: getAssetPath('commands/cht-specialist.md') },
];

export async function installCommands(
  target: Target,
  location: 'global' | 'project',
  commandNames: string[],
  options?: InstallOptions
): Promise<void> {
  const commands = CHT_COMMANDS.filter(c => commandNames.includes(c.name));
  for (const cmd of commands) {
    await target.installCommand(cmd, location, options);
  }
}
