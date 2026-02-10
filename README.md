# @medic/cht-ai-tools

AI development tools for the [Community Health Toolkit](https://communityhealthtoolkit.org/) (CHT). Installs CHT-specific skills, MCP servers, commands, and hooks into [Claude Code](https://claude.ai/code) or [OpenCode](https://opencode.ai).

## Installation

### Claude Code

#### As a plugin (recommended)

Run the following slash commands inside Claude Code:

```
/plugin marketplace add medic/cht-ai-tools
/plugin install cht-ai-tools@medic-cht-ai-tools
```

Restart Claude Code after installation.

#### Via CLI

```bash
npx @medic/cht-ai-tools install
```

### OpenCode

See [.opencode/INSTALL.md](.opencode/INSTALL.md) for full setup instructions (git clone + symlinks).

Or use the CLI:

```bash
npx @medic/cht-ai-tools install --target opencode
```

> **Note:** Hooks are not supported in OpenCode and will be skipped automatically.

## What It Installs

| Component | Claude Code | OpenCode |
|-----------|:-----------:|:--------:|
| **CHT Skills** (`cht-specialist`, `create-cht-task`, `create-cht-target`) | ✓ | ✓ |
| **CHT Docs MCP** (documentation access) | ✓ | ✓ |
| **Slash Commands** (`/cht-task`, `/cht-target`, `/cht-specialist`) | ✓ | ✓ |
| **Hooks** (validation & formatting) | ✓ | — |

## CLI Usage

The CLI supports interactive prompts, non-interactive flags, and selective installation.

```bash
npx @medic/cht-ai-tools install                # Interactive mode (auto-detect target)
npx @medic/cht-ai-tools install --all          # Install everything
npx @medic/cht-ai-tools install --target opencode --all
npx @medic/cht-ai-tools install --skills --mcp --project
```

| Flag | Description |
|------|-------------|
| `--target <name>` | Target platform: `claude-code` or `opencode` (auto-detected if omitted) |
| `--skills` | Install CHT skills |
| `--mcp` | Install MCP servers |
| `--commands` | Install slash commands |
| `--hooks` | Install validation/formatting hooks (Claude Code only) |
| `--all`, `-y`, `--yes` | Install all components (non-interactive) |
| `--project` | Install to project directory instead of global config |

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

### Hooks (Claude Code only)

Automatic validation and formatting of CHT configuration files (`tasks.js`, `targets.js`, `contact-summary.templated.js`, `purge.js`):

- **validate-cht** (PreToolUse → Bash) - Syntax-checks CHT config files before commands run
- **format-cht** (PostToolUse → Write) - Auto-formats CHT config files via ESLint after writes

> **Note:** Hook installation merges into your existing `settings.json`. If you have custom hooks on the same event+matcher (e.g., other `PreToolUse → Bash` hooks), they will be preserved alongside the CHT hooks.

## Configuration Locations

### Claude Code

| Location | Path | Use Case |
|----------|------|----------|
| Global | `~/.claude/` | Available in all projects |
| Project | `./.claude/` | Specific to current project |

### OpenCode

| Location | Skills & Commands | MCP Config (`opencode.json`) |
|----------|-------------------|------------------------------|
| Global | `~/.config/opencode/` | `~/.config/opencode/opencode.json` |
| Project | `./.opencode/` | `./opencode.json` |

## Requirements

The plugin install method (`/plugin marketplace add` + `/plugin install`) requires only Claude Code — no Node.js needed.

The CLI install method (`npx`) requires:

- Node.js 18+
- Claude Code or OpenCode

The OpenCode manual setup (git clone + symlinks) requires only Git.

---

## Architecture

```
cht-ai-tools/
├── .claude-plugin/           # Claude Code plugin manifest
│   └── plugin.json
├── .opencode/                # OpenCode install guide
│   └── INSTALL.md
├── src/
│   ├── index.ts              # CLI entry point
│   ├── cli/
│   │   ├── install.ts        # Main install command
│   │   ├── prompts.ts        # Clack interactive prompts
│   │   └── utils.ts          # File operation helpers
│   ├── targets/              # AI tool adapters (extensible)
│   │   ├── base.ts           # Target interface
│   │   ├── utils.ts          # Shared utilities (JSON config, path checks)
│   │   ├── claude-code.ts    # Claude Code implementation
│   │   ├── opencode.ts       # OpenCode implementation
│   │   └── registry.ts       # Target auto-detection registry
│   ├── installers/           # Tool-agnostic installation logic
│   │   ├── skills.ts
│   │   ├── mcp.ts
│   │   ├── commands.ts
│   │   ├── hooks.ts
│   │   ├── common.ts         # Asset path resolution
│   │   └── index.ts
│   └── __tests__/
│       ├── claude-code.test.ts
│       ├── opencode.test.ts
│       └── registry.test.ts
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

Currently implemented targets:

| Target | Skills | MCP | Commands | Hooks |
|--------|:------:|:---:|:--------:|:-----:|
| Claude Code | ✓ | ✓ | ✓ | ✓ |
| OpenCode | ✓ | ✓ | ✓ | — |

To add support for another AI tool (e.g., Cursor, Windsurf):

1. Create `src/targets/cursor.ts` implementing the `Target` interface
2. Add detection and installation logic specific to that tool
3. Register it in `src/targets/registry.ts`

---

## License

AGPL-3.0 - See [LICENSE](LICENSE) for details.

## About CHT

The [Community Health Toolkit](https://communityhealthtoolkit.org/) (CHT) is an open-source platform for building digital health applications for community health workers.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add new skills, commands, MCP servers, and hooks.
