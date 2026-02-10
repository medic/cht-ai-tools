# Contributing to @medic/cht-ai-tools

Read about how to contribute to the CHT on the [documentation site](https://docs.communityhealthtoolkit.org/contribute/).

## Development Setup

```bash
git clone https://github.com/medic/cht-ai-tools.git
cd cht-ai-tools
npm install
npm run build
```

### Commands

```bash
npm run build          # Build with tsup (ESM, Node 18+)
npm run dev            # Watch mode rebuild
npm test               # Run vitest test suite
npm run test:watch     # Watch mode tests
npm run typecheck      # Type-check without emitting
```

### Manual CLI Testing

```bash
npm run build
node dist/index.js install

# Or link globally
npm link
cht-ai-tools install
```

#### Test Installation to a Temp Directory

```bash
mkdir /tmp/test-cht-project && cd /tmp/test-cht-project

# Claude Code
npx /path/to/cht-ai-tools install --target claude-code --project
ls -la .claude/skills/
cat .claude/mcp_config.json

# OpenCode
npx /path/to/cht-ai-tools install --target opencode --project
ls -la .opencode/skills/
cat opencode.json
```

#### Verify in Claude Code

1. Restart Claude Code after installation
2. Test slash commands: `/cht-task`, `/cht-target`, `/cht-specialist`
3. Check MCP server is available in Claude Code's MCP list

#### Verify in OpenCode

1. Restart OpenCode after installation
2. Test slash commands: `/cht-task`, `/cht-target`, `/cht-specialist`
3. Verify `opencode.json` has MCP config with `"type": "remote"` entries

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
# After installation, use /my-command in Claude Code or OpenCode
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
node dist/index.js install
# Claude Code: check ~/.claude/mcp_config.json
# OpenCode: check ~/.config/opencode/opencode.json
```

### Adding a New Hook

Hooks are Claude Code only. OpenCode does not support hooks.

1. **Create the hook script** in `hooks/scripts/` at the package root:

```bash
#!/bin/bash
# hooks/scripts/my-hook.sh

# Your validation/formatting logic here
if [[ -f "some-file.js" ]]; then
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
    matcher: 'Write',          // Optional: tool name to match
    scriptName: 'my-hook.sh',
    sourcePath: getAssetPath('hooks/scripts/my-hook.sh'),
  },
];
```

4. **Hook events**:

| Event | When it runs |
|-------|--------------|
| `PreToolUse` | Before a tool executes (can block execution) |
| `PostToolUse` | After a tool executes |
| `Stop` | When Claude Code session ends |

5. **Build and test**:

```bash
npm run build
node dist/index.js install
# Check ~/.claude/settings.json for hooks configuration
```

### Adding a New Target

To add support for another AI tool (e.g., Cursor, Windsurf):

1. Create `src/targets/my-tool.ts` implementing the `Target` interface from `src/targets/base.ts`
2. Add detection and installation logic specific to that tool
3. Register it in `src/targets/registry.ts` by adding to the `ALL_TARGETS` array
4. Add display name mappings in `src/cli/install.ts` and path hints in `src/cli/prompts.ts`
5. Write tests in `src/__tests__/my-tool.test.ts`

## Commits

Uses conventional commits enforced by commitlint + husky. Use `npm run cz` for the interactive commit wizard. Semantic-release automates versioning and npm publishing on push to `main`.
