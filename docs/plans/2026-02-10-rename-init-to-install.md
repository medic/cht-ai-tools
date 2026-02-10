# Rename `init` to `install` + Granular CLI Flags

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename the CLI subcommand from `init` to `install` and add granular component flags (`--skills`, `--mcp`, `--commands`, `--hooks`) for non-interactive selective installation.

**Architecture:** The CLI entry point (`src/index.ts`) gets proper argument parsing with a positional `install` subcommand and component flags. When any component flag is passed, the CLI skips interactive prompts and installs only the requested components. When no flags are passed, the existing interactive flow remains unchanged. The file `src/cli/init.ts` is renamed to `src/cli/install.ts` with updated exports.

**Tech Stack:** TypeScript, tsup, @clack/prompts, picocolors

---

### Task 1: Rename `src/cli/init.ts` to `src/cli/install.ts`

**Files:**
- Delete: `src/cli/init.ts`
- Create: `src/cli/install.ts`

**Step 1: Create `src/cli/install.ts` with renamed exports**

Copy the contents of `src/cli/init.ts` into `src/cli/install.ts`, renaming:
- `runInit` → `runInstall`
- `InitOptions` → `InstallOptions`

```typescript
// src/cli/install.ts
import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  promptInstallLocation,
  promptItems,
  allItems,
  type InstallLocation,
  type SelectionResult,
} from './prompts.js';
import { ensureDir } from './utils.js';
import { ClaudeCodeTarget } from '../targets/claude-code.js';
import {
  installSkills,
  installMcp,
  installCommands,
  installHooks,
} from '../installers/index.js';

const target = new ClaudeCodeTarget();

/**
 * Format selection for display
 */
function formatSelection(selection: SelectionResult): string {
  const parts: string[] = [];
  if (selection.skills.length) parts.push(...selection.skills);
  if (selection.mcp.length) parts.push(...selection.mcp);
  if (selection.commands.length) parts.push(...selection.commands.map(c => `/${c}`));
  if (selection.hooks.length) parts.push(...selection.hooks);
  return parts.map(s => pc.cyan(s)).join(', ');
}

/**
 * Install selected items
 */
async function installSelectedItems(
  selection: SelectionResult,
  location: InstallLocation
): Promise<void> {
  const spinner = p.spinner();
  spinner.start('Installing components...');

  const basePath = target.getConfigPath(location);
  await ensureDir(basePath);

  const results: string[] = [];

  try {
    if (selection.skills.length) {
      await installSkills(target, location, selection.skills, { overwrite: true });
      results.push(`${pc.green('✓')} Skills: ${selection.skills.join(', ')}`);
    }

    if (selection.mcp.length) {
      await installMcp(target, location, selection.mcp);
      results.push(`${pc.green('✓')} MCP: ${selection.mcp.join(', ')}`);
    }

    if (selection.commands.length) {
      await installCommands(target, location, selection.commands, { overwrite: true });
      results.push(`${pc.green('✓')} Commands: ${selection.commands.map(c => `/${c}`).join(', ')}`);
    }

    if (selection.hooks.length) {
      await installHooks(target, location, selection.hooks);
      results.push(`${pc.green('✓')} Hooks: ${selection.hooks.join(', ')}`);
    }

    spinner.stop('Components installed');

    for (const result of results) {
      p.log.success(result);
    }
  } catch (error) {
    spinner.stop('Installation failed');
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(`Failed to install: ${pc.red(message)}`);
    throw error;
  }
}

export interface InstallOptions {
  nonInteractive?: boolean;
  skills?: boolean;
  mcp?: boolean;
  commands?: boolean;
  hooks?: boolean;
  project?: boolean;
}

/**
 * Main install command entry point
 */
export async function runInstall(options: InstallOptions = {}): Promise<void> {
  console.clear();

  p.intro(pc.bgCyan(pc.black(' CHT AI Tools ')));

  p.log.info(
    `Install CHT-specific skills, MCP servers, and tools into ${pc.cyan('Claude Code')}`
  );

  // Check if Claude Code is detected
  const detected = await target.detect();
  if (!detected) {
    p.log.warn(
      `Claude Code not detected. The ${pc.cyan('~/.claude/')} directory will be created.`
    );
  }

  // Determine if component flags were passed
  const hasComponentFlags = options.skills || options.mcp || options.commands || options.hooks;

  let location: InstallLocation;
  let selection: SelectionResult;

  if (options.nonInteractive || hasComponentFlags) {
    // Non-interactive: use flags to determine what to install
    location = options.project ? 'project' : 'global';

    if (hasComponentFlags) {
      // Build selection from flags
      const all = allItems();
      selection = {
        skills: options.skills ? all.skills : [],
        mcp: options.mcp ? all.mcp : [],
        commands: options.commands ? all.commands : [],
        hooks: options.hooks ? all.hooks : [],
      };
    } else {
      // --all / --yes: install everything
      selection = allItems();
    }

    p.log.step(`Installing ${formatSelection(selection)} to ${pc.cyan(location === 'global' ? '~/.claude/' : './.claude/')}`);
  } else {
    // Interactive mode (no flags passed)
    location = await promptInstallLocation();

    p.log.step(
      `Installing to ${pc.cyan(location === 'global' ? '~/.claude/' : './.claude/')}`
    );

    selection = await promptItems();

    const totalItems =
      selection.skills.length +
      selection.mcp.length +
      selection.commands.length +
      selection.hooks.length;

    if (totalItems === 0) {
      p.cancel('No items selected.');
      process.exit(0);
    }

    p.log.step(`Selected: ${formatSelection(selection)}`);
  }

  // Install items
  await installSelectedItems(selection, location);

  // Show success message
  p.outro(
    pc.green('Installation complete!') +
      '\n\n' +
      pc.dim('  Restart Claude Code to use CHT tools.')
  );
}
```

**Step 2: Delete `src/cli/init.ts`**

Remove the old file.

**Step 3: Verify the project compiles**

Run: `npm run typecheck`
Expected: Clean output (no errors)

**Step 4: Commit**

```bash
git add src/cli/install.ts
git rm src/cli/init.ts
git commit -m "refactor: rename init.ts to install.ts with InstallOptions"
```

---

### Task 2: Update `src/index.ts` with new subcommand and flag parsing

**Files:**
- Modify: `src/index.ts`

**Step 1: Rewrite `src/index.ts` with subcommand and flag support**

```typescript
#!/usr/bin/env node
import { runInstall } from './cli/install.js';

const args = process.argv.slice(2);

declare const __VERSION__: string;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  CHT AI Tools - Install CHT tools into Claude Code

  Usage:
    npx @medic/cht-ai-tools install [options]

  Options:
    --skills      Install skills only
    --mcp         Install MCP servers only
    --commands    Install slash commands only
    --hooks       Install hooks only
    --all, -y     Install all components (non-interactive)
    --project     Install to ./.claude/ instead of ~/.claude/
    --help, -h    Show this help message
    --version     Show version number

  Examples:
    npx @medic/cht-ai-tools install              # Interactive mode
    npx @medic/cht-ai-tools install --all        # Install everything
    npx @medic/cht-ai-tools install --skills     # Skills only
    npx @medic/cht-ai-tools install --skills --mcp --project
`);
  process.exit(0);
}

if (args.includes('--version')) {
  console.log(__VERSION__);
  process.exit(0);
}

// Parse flags
const hasFlag = (flag: string) => args.includes(flag);

runInstall({
  nonInteractive: hasFlag('--all') || hasFlag('--yes') || hasFlag('-y'),
  skills: hasFlag('--skills'),
  mcp: hasFlag('--mcp'),
  commands: hasFlag('--commands'),
  hooks: hasFlag('--hooks'),
  project: hasFlag('--project'),
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Key design decisions:
- `install` subcommand is implicit (no positional arg parsing needed since there's only one command)
- `--all` is the new primary flag; `--yes`/`-y` kept as aliases for backwards compatibility
- Component flags (`--skills`, `--mcp`, etc.) trigger non-interactive mode automatically
- `--project` controls location; defaults to global when not specified

**Step 2: Verify the project compiles**

Run: `npm run typecheck`
Expected: Clean output (no errors)

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add granular install flags (--skills, --mcp, --commands, --hooks)"
```

---

### Task 3: Build and manually verify

**Files:**
- None (verification only)

**Step 1: Build the project**

Run: `npm run build`
Expected: Clean build with "✓ Assets copied to dist/assets" message

**Step 2: Test help output**

Run: `node dist/index.js --help`
Expected: Updated help text showing `install` usage and all new flags

**Step 3: Test version output**

Run: `node dist/index.js --version`
Expected: `0.1.0`

**Step 4: Test non-interactive with --all**

Run: `node dist/index.js install --all`
Expected: Installs all components to `~/.claude/` without prompts

**Step 5: Test granular flag (skills only)**

Run: `node dist/index.js install --skills --project`
Expected: Installs only skills to `./.claude/` without prompts

**Step 6: Test interactive mode (no flags)**

Run: `node dist/index.js install`
Expected: Shows interactive prompts (same as before)

**Step 7: Commit (nothing to commit - verification only)**

No commit needed.

---

### Task 4: Update README.md

**Files:**
- Modify: `README.md`

**Step 1: Update all `init` references to `install`**

Replace every occurrence of `init` with `install` in the usage sections:

- `npx @medic/cht-ai-tools init` → `npx @medic/cht-ai-tools install`
- `npx @medic/cht-ai-tools init --yes` → `npx @medic/cht-ai-tools install --all`
- `cht-ai-tools init` → `cht-ai-tools install`

**Step 2: Add new flags documentation to the Usage section**

After the "Non-Interactive Mode" section, add a "Selective Installation" section:

```markdown
### Selective Installation

Install specific components without interactive prompts:

```bash
# Install only skills
npx @medic/cht-ai-tools install --skills

# Install skills and MCP servers
npx @medic/cht-ai-tools install --skills --mcp

# Install everything to current project
npx @medic/cht-ai-tools install --all --project

# Install hooks to current project
npx @medic/cht-ai-tools install --hooks --project
```

#### Available Flags

| Flag | Description |
|------|-------------|
| `--skills` | Install CHT skills |
| `--mcp` | Install MCP servers |
| `--commands` | Install slash commands |
| `--hooks` | Install validation/formatting hooks |
| `--all` | Install all components (non-interactive) |
| `--project` | Install to `./.claude/` instead of `~/.claude/` |
```

**Step 3: Update the architecture section**

Change `init.ts` reference to `install.ts` in the architecture tree:

```
├── cli/
│   ├── install.ts       # Main install command
│   ├── prompts.ts       # Clack interactive prompts
│   └── utils.ts         # File operation helpers
```

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README for install command and granular flags"
```

---

## Summary of All Changes

| File | Action | Description |
|------|--------|-------------|
| `src/cli/init.ts` | Delete | Old entry point |
| `src/cli/install.ts` | Create | Renamed from init.ts, new `InstallOptions` with component flags |
| `src/index.ts` | Modify | New help text, flag parsing, import updated |
| `README.md` | Modify | All `init` → `install`, document new flags |

## Flag Behavior Matrix

| Flags | Interactive? | Location | Components |
|-------|-------------|----------|------------|
| (none) | Yes | Prompted | Prompted |
| `--all` | No | Global | All |
| `--skills` | No | Global | Skills only |
| `--skills --mcp` | No | Global | Skills + MCP |
| `--skills --project` | No | Project | Skills only |
| `--all --project` | No | Project | All |
| `--yes` / `-y` | No | Global | All (backwards compat) |
