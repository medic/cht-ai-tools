import type { Target, Skill, InstallOptions } from '../targets/base.js';
import { getAssetPath } from './common.js';

export const CHT_SKILLS: Skill[] = [
  { name: 'cht-specialist', sourcePath: getAssetPath('skills/cht-specialist') },
  { name: 'create-cht-task', sourcePath: getAssetPath('skills/create-cht-task') },
  { name: 'create-cht-target', sourcePath: getAssetPath('skills/create-cht-target') },
];

export async function installSkills(
  target: Target,
  location: 'global' | 'project',
  skillNames: string[],
  options?: InstallOptions
): Promise<void> {
  const skills = CHT_SKILLS.filter(s => skillNames.includes(s.name));
  for (const skill of skills) {
    await target.installSkill(skill, location, options);
  }
}
