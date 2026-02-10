# @medic/cht-ai-tools

AI development tools for the Community Health Toolkit (CHT). This CLI installs CHT-specific AI development tools into Claude Code.

## Installation

```bash
npx @medic/cht-ai-tools install
```

## What It Installs

| Component | Description |
|-----------|-------------|
| **CHT Skills** | `cht-specialist`, `create-cht-task`, `create-cht-target` |
| **CHT Docs MCP** | MCP server for CHT documentation access |
| **Slash Commands** | `/cht-task`, `/cht-target`, `/cht-specialist` |
| **Hooks** | Pre-tool validation and post-tool formatting for CHT config files |

## Usage

### Interactive Mode

```bash
npx @medic/cht-ai-tools install
```

Follow the prompts to:
1. Choose installation location (global or project-specific)
2. Select components to install

### Non-Interactive Mode

```bash
npx @medic/cht-ai-tools install --all
```

Installs all components to global location.

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
| `--all`, `-y`, `--yes` | Install all components (non-interactive) |
| `--project` | Install to `./.claude/` instead of `~/.claude/` |

## Components

### CHT Specialist Skill

Expert guidance on CHT development, configuration, and troubleshooting:

- CHT architecture and data model
- App configuration (tasks, targets, contact summaries)
- XLSForm/ODK form development
- cht-conf CLI usage
- Deployment and hosting
- API integration

### Create CHT Task Skill

Interactive task creation with:

- Project detection
- Form integration
- Contact type awareness
- Best practices enforcement

### Create CHT Target Skill

KPI/indicator creation with:

- Counting mode guidance (instance vs contact)
- Aggregation setup
- Goal configuration
- Form field integration

### CHT Docs MCP Server

Direct access to CHT documentation through the Model Context Protocol:

```
https://mcp-docs.dev.medicmobile.org/mcp
```

### Slash Commands

Quick access to skills:

- `/cht-task` - Create or modify task definitions
- `/cht-target` - Create or modify target definitions
- `/cht-specialist` - Get expert CHT assistance

### Hooks

Automatic validation and formatting of CHT configuration files (`tasks.js`, `targets.js`, `contact-summary.templated.js`, `purge.js`):

- **validate-cht** (PreToolUse → Bash) - Syntax-checks CHT config files before commands run
- **format-cht** (PostToolUse → Write) - Auto-formats CHT config files via ESLint after writes

## Configuration Locations

| Location | Path | Use Case |
|----------|------|----------|
| Global | `~/.claude/` | Available in all projects |
| Project | `./.claude/` | Specific to current project |

## Requirements

- Node.js 18+
- Claude Code CLI

---

## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/medic/cht-ai-tools.git
cd cht-ai-tools

# Install dependencies
npm install

# Build
npm run build

# Run locally
node dist/index.js install
```

### Testing

```bash
# Run the test suite
npm test

# Watch mode
npm run test:watch

# Type check
npm run typecheck
```

#### Manual CLI Testing

```bash
# Build first
npm run build

# Run the CLI
node dist/index.js install

# Or link it globally for testing
npm link
cht-ai-tools install
```

#### Test Installation to a Temp Directory

```bash
# Create a test project
mkdir /tmp/test-cht-project && cd /tmp/test-cht-project

# Run the CLI (project-local install)
npx /path/to/cht-ai-tools install --project

# Verify installed files
ls -la .claude/skills/
ls -la .claude/commands/
cat .claude/mcp_config.json
cat .claude/settings.json
```

#### Verify in Claude Code

1. Restart Claude Code after installation
2. Test slash commands: `/cht-task`, `/cht-target`, `/cht-specialist`
3. Check MCP server is available in Claude Code's MCP list
4. Test skills by asking CHT-related questions

### Watch Mode (Development)

```bash
npm run dev
```

This rebuilds on file changes. Run the CLI in another terminal to test.

---

## Adding New Components

### Adding a New Skill

1. **Create the skill directory** in `skills/` at the package root:

```
skills/my-new-skill/
├── SKILL.md           # Main skill definition (required)
├── references/        # Reference documentation
│   └── *.md
├── scripts/           # Helper scripts (optional)
│   └── *.sh, *.py
└── assets/            # Templates, examples (optional)
    └── templates/
```

2. **Create `SKILL.md`** with frontmatter:

```markdown
---
name: my-new-skill
description: Brief description of what the skill does
---

# My New Skill

Detailed instructions for Claude on how to use this skill...
```

3. **Register the skill** in `src/installers/skills.ts`:

```typescript
export const CHT_SKILLS: Skill[] = [
  { name: 'cht-specialist', sourcePath: getAssetPath('skills/cht-specialist') },
  { name: 'create-cht-task', sourcePath: getAssetPath('skills/create-cht-task') },
  { name: 'create-cht-target', sourcePath: getAssetPath('skills/create-cht-target') },
  // Add your new skill:
  { name: 'my-new-skill', sourcePath: getAssetPath('skills/my-new-skill') },
];
```

4. **Build and test**:

```bash
npm run build
node dist/index.js install
```

### Adding a New Slash Command

1. **Create the command file** in `commands/` at the package root:

```markdown
<!-- commands/my-command.md -->
---
description: Brief description shown in command list
---

Invoke the `my-skill-name` skill to [describe what this command does].

Additional context or instructions for Claude...
```

2. **Register the command** in `src/installers/commands.ts`:

```typescript
export const CHT_COMMANDS: Command[] = [
  { name: 'cht-task', sourcePath: getAssetPath('commands/cht-task.md') },
  { name: 'cht-target', sourcePath: getAssetPath('commands/cht-target.md') },
  { name: 'cht-specialist', sourcePath: getAssetPath('commands/cht-specialist.md') },
  // Add your new command:
  { name: 'my-command', sourcePath: getAssetPath('commands/my-command.md') },
];
```

3. **Build and test**:

```bash
npm run build
# After installation, use /my-command in Claude Code
```

### Adding a New MCP Server

1. **Add to the `CHT_MCP_SERVERS` array** in `src/installers/mcp.ts`:

```typescript
export const CHT_MCP_SERVERS: McpServer[] = [
  {
    name: 'cht-docs',
    type: 'http',
    url: 'https://mcp-docs.dev.medicmobile.org/mcp',
  },
  // Add your new server (HTTP):
  {
    name: 'my-server',
    type: 'http',
    url: 'https://my-server.example.com/mcp',
  },
  // Or add a stdio-based server:
  {
    name: 'local-server',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@my-org/my-mcp-server'],
  },
];
```

2. **Build and test**:

```bash
npm run build
node dist/index.js
# Check ~/.claude/mcp_config.json or .claude/mcp_config.json
```

### Adding a New Hook

1. **Create the hook script** in `hooks/scripts/` at the package root:

```bash
#!/bin/bash
# hooks/scripts/my-hook.sh
# Description of what this hook does

# Your validation/formatting logic here
if [[ -f "some-file.js" ]]; then
  # Do something
  echo "Hook executed"
fi

exit 0
```

2. **Make it executable**:

```bash
chmod +x hooks/scripts/my-hook.sh
```

3. **Register the hook** in `src/installers/hooks.ts`:

```typescript
import type { Target, Hook } from '../targets/base.js';
import { getAssetPath } from './common.js';

export const CHT_HOOKS: Hook[] = [
  {
    event: 'PreToolUse',
    matcher: 'Bash',
    scriptName: 'validate-cht.sh',
    sourcePath: getAssetPath('hooks/scripts/validate-cht.sh'),
  },
  // Add your new hook:
  {
    event: 'PostToolUse',      // 'PreToolUse' | 'PostToolUse' | 'Stop'
    matcher: 'Write',          // Optional: tool name to match (e.g., 'Bash', 'Write', 'Edit')
    scriptName: 'my-hook.sh',
    sourcePath: getAssetPath('hooks/scripts/my-hook.sh'),
  },
];
```

4. **Hook events explained**:

| Event | When it runs |
|-------|--------------|
| `PreToolUse` | Before a tool executes (can block execution) |
| `PostToolUse` | After a tool executes |
| `Stop` | When Claude Code session ends |

5. **Build and test**:

```bash
npm run build
node dist/index.js
# Check ~/.claude/settings.json for hooks configuration
```

---

## Architecture

```
cht-ai-tools/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── cli/
│   │   ├── install.ts        # Main install command
│   │   ├── prompts.ts        # Clack interactive prompts
│   │   └── utils.ts          # File operation helpers
│   ├── targets/              # AI tool adapters (extensible)
│   │   ├── base.ts           # Target interface
│   │   └── claude-code.ts    # Claude Code implementation
│   ├── installers/           # Tool-agnostic installation logic
│   │   ├── skills.ts
│   │   ├── mcp.ts
│   │   ├── commands.ts
│   │   ├── hooks.ts
│   │   ├── common.ts         # Asset path resolution
│   │   └── index.ts
│   └── __tests__/
│       └── claude-code.test.ts
├── skills/                   # Bundled skill assets (package root)
├── commands/                 # Bundled command assets
└── hooks/                    # Bundled hook assets
    ├── hooks.json            # Plugin hook definitions
    └── scripts/
```

### Target Abstraction

The `Target` interface (`src/targets/base.ts`) allows supporting multiple AI tools:

```typescript
interface Target {
  name: string;
  detect(): Promise<boolean>;
  getConfigPath(location: 'global' | 'project'): string;
  installSkill(skill: Skill, location, options?): Promise<void>;
  configureMcp(server: McpServer, location): Promise<void>;
  installCommand(cmd: Command, location, options?): Promise<void>;
  configureHook(hook: Hook, location): Promise<void>;
}
```

To add support for another AI tool (e.g., Cursor, Windsurf):

1. Create `src/targets/cursor.ts` implementing the `Target` interface
2. Add detection and installation logic specific to that tool
3. Update CLI to allow target selection

---

## License

AGPL-3.0 - See [LICENSE](LICENSE) for details.

## About CHT

The [Community Health Toolkit](https://communityhealthtoolkit.org/) (CHT) is an open-source platform for building digital health applications for community health workers.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on the process for submitting pull requests.
