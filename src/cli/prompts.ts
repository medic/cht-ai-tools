import * as p from '@clack/prompts';
import { CHT_SKILLS } from '../installers/skills.js';
import { CHT_MCP_SERVERS } from '../installers/mcp.js';
import { CHT_COMMANDS } from '../installers/commands.js';
import { CHT_HOOKS } from '../installers/hooks.js';
import { hookDisplayName } from '../targets/base.js';

export type InstallLocation = 'global' | 'project';

export interface SelectionResult {
  skills: string[];
  mcp: string[];
  commands: string[];
  hooks: string[];
}

const validCategories = new Set<keyof SelectionResult>(['skills', 'mcp', 'commands', 'hooks']);

function isSelectionCategory(key: string): key is keyof SelectionResult {
  return validCategories.has(key as keyof SelectionResult);
}

/**
 * Parse "category:name" selection strings into a SelectionResult
 */
function parseSelections(selections: string[]): SelectionResult {
  const result: SelectionResult = { skills: [], mcp: [], commands: [], hooks: [] };
  for (const sel of selections) {
    const [category, name] = sel.split(':');
    if (isSelectionCategory(category)) {
      result[category].push(name);
    }
  }
  return result;
}

/**
 * Build a SelectionResult containing all available items
 */
export function allItems(): SelectionResult {
  return {
    skills: CHT_SKILLS.map(s => s.name),
    mcp: CHT_MCP_SERVERS.map(s => s.name),
    commands: CHT_COMMANDS.map(c => c.name),
    hooks: CHT_HOOKS.map(h => hookDisplayName(h)),
  };
}

/**
 * Prompt user to select installation location
 */
export async function promptInstallLocation(): Promise<InstallLocation> {
  const location = await p.select({
    message: 'Where would you like to install CHT tools?',
    options: [
      {
        value: 'global' as const,
        label: 'Global',
        hint: `Install to ~/.claude/ for all projects`,
      },
      {
        value: 'project' as const,
        label: 'Project',
        hint: `Install to ./.claude/ for this project only`,
      },
    ],
  });

  if (p.isCancel(location)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  return location;
}

/**
 * Prompt user to select individual items to install
 */
export async function promptItems(): Promise<SelectionResult> {
  const skillOptions = CHT_SKILLS.map(s => ({
    value: `skills:${s.name}`,
    label: s.name,
  }));

  const mcpOptions = CHT_MCP_SERVERS.map(s => ({
    value: `mcp:${s.name}`,
    label: s.name,
    hint: s.url,
  }));

  const commandOptions = CHT_COMMANDS.map(c => ({
    value: `commands:${c.name}`,
    label: `/${c.name}`,
  }));

  const hookOptions = CHT_HOOKS.map(h => ({
    value: `hooks:${hookDisplayName(h)}`,
    label: hookDisplayName(h),
    hint: `${h.event} → ${h.matcher}`,
  }));

  const defaultValues = [
    ...skillOptions.map(o => o.value),
    ...mcpOptions.map(o => o.value),
  ];

  const selections = await p.groupMultiselect({
    message: 'Which items would you like to install?',
    options: {
      'Skills': skillOptions,
      'MCP Servers': mcpOptions,
      'Slash Commands': commandOptions,
      'Hooks': hookOptions,
    },
    initialValues: defaultValues,
    required: true,
  });

  if (p.isCancel(selections)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  return parseSelections(selections);
}
