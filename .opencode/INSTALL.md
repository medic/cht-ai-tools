# Installing CHT AI Tools for OpenCode

## Prerequisites

- [OpenCode](https://opencode.ai) installed
- Git installed

## Installation Steps

### 1. Clone the repository

```bash
git clone https://github.com/medic/cht-ai-tools.git ~/.config/opencode/cht-ai-tools
```

### 2. Symlink skills

Create symlinks so OpenCode discovers the CHT skills:

```bash
mkdir -p ~/.config/opencode/skills
ln -sf ~/.config/opencode/cht-ai-tools/skills/cht-specialist ~/.config/opencode/skills/cht-specialist
ln -sf ~/.config/opencode/cht-ai-tools/skills/create-cht-task ~/.config/opencode/skills/create-cht-task
ln -sf ~/.config/opencode/cht-ai-tools/skills/create-cht-target ~/.config/opencode/skills/create-cht-target
```

### 3. Symlink commands

```bash
mkdir -p ~/.config/opencode/commands
ln -sf ~/.config/opencode/cht-ai-tools/commands/cht-specialist.md ~/.config/opencode/commands/cht-specialist.md
ln -sf ~/.config/opencode/cht-ai-tools/commands/cht-task.md ~/.config/opencode/commands/cht-task.md
ln -sf ~/.config/opencode/cht-ai-tools/commands/cht-target.md ~/.config/opencode/commands/cht-target.md
```

### 4. Configure MCP server

Add the CHT docs MCP server to your `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "cht-docs": {
      "type": "remote",
      "url": "https://mcp-docs.dev.medicmobile.org/mcp",
      "enabled": true
    }
  }
}
```

If you already have other keys in `opencode.json`, just add the `cht-docs` entry under the `mcp` key.

### 5. Restart OpenCode

Restart OpenCode to pick up the new skills, commands, and MCP server.

## Usage

### Skills

Use OpenCode's native `skill` tool to load a CHT skill:

```
use skill tool to load cht-specialist
```

### Commands

Use slash commands directly:

- `/cht-task` — Create or modify CHT task definitions
- `/cht-target` — Create or modify CHT target definitions
- `/cht-specialist` — Get expert CHT assistance

## Updating

```bash
cd ~/.config/opencode/cht-ai-tools && git pull
```

## Alternative: CLI install

Instead of the manual setup above, you can use the CLI:

```bash
npx @medic/cht-ai-tools install --target opencode
```

This automates skills, commands, and MCP configuration (copies files instead of symlinks).

## Notes

- Hooks are not supported in OpenCode and are not installed.
- Project-level installs use `.opencode/` in your project directory.
