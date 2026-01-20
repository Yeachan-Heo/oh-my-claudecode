---
description: Guide on using oh-my-claudecode plugin
---

# Oh My Claude Sisyphus - Help Guide

Welcome! This plugin provides multi-agent orchestration, intelligent model routing, and powerful productivity commands for Claude Code.

$ARGUMENTS

## Quick Start

### Core Modes

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `/sisyphus` | Default orchestration mode | Complex multi-step tasks with delegation |
| `/ultrawork` | Maximum intensity parallel mode | High-throughput tasks, aggressive delegation |
| `/ralph` | Self-referential development loop | Complete features end-to-end until done |

### Planning & Analysis

| Command | Purpose |
|---------|---------|
| `/plan` | Start planning session with Prometheus |
| `/planner` | Strategic planning consultant |
| `/review` | Review plans with Momus critic |
| `/analyze` | Deep analysis and investigation |

### Development Workflows

| Command | Purpose |
|---------|---------|
| `/ralph-init` | Initialize PRD for structured development |
| `/ultraqa` | QA cycling workflow (test, fix, repeat) |
| `/git-master` | Git expert for commits, rebasing, history |
| `/frontend-ui-ux` | UI/UX designer-developer |

### Codebase Navigation

| Command | Purpose |
|---------|---------|
| `/deepinit` | Create hierarchical AGENTS.md documentation |
| `/deepsearch` | Thorough codebase search |

### Memory & Context

| Command | Purpose |
|---------|---------|
| `/note <text>` | Save notes to notepad.md |
| `/note --priority <text>` | Save to priority context |
| `/note --show` | Display notepad contents |

### Control

| Command | Purpose |
|---------|---------|
| `/cancel-ralph` | Cancel active Ralph loop |
| `/cancel-ultraqa` | Cancel active UltraQA workflow |

### Configuration

| Command | Purpose |
|---------|---------|
| `/sisyphus-default` | Configure locally (.claude/CLAUDE.md) |
| `/sisyphus-default-global` | Configure globally (~/.claude/CLAUDE.md) |
| `/doctor` | Diagnose installation issues |

## Agent Types

The plugin provides 19 specialized agents with intelligent model routing:

### General Purpose
- `executor` - Focused task executor
- `executor-low` - Simple tasks (Haiku)
- `executor-high` - Complex tasks (Opus)

### Specialized
- `architect` - Architecture & debugging advisor (read-only)
- `designer` - UI/UX development
- `writer` - Technical documentation
- `researcher` - External documentation research
- `explore` - Fast codebase exploration
- `qa-tester` - Interactive CLI testing
- `analyst` - Requirements analysis
- `planner` - Strategic planning
- `critic` - Plan review expert

## Tips

### Effective Usage
1. **Use /note for context** - Save important findings that survive compaction
2. **Start with /plan** - For complex features, plan first
3. **Try /ultrawork** - When you need maximum parallelization
4. **Use /ralph-loop** - When you want autonomous completion
5. **Check /doctor** - If something seems broken

### Best Practices
- Let agents delegate to sub-agents for complex tasks
- Use priority notes for critical project info
- Review plans with /review before implementation
- Use /deepinit once per project for better agent context

## Example Workflows

### Feature Development
```
/ralph-init   # Create PRD
/plan         # Design approach
/ultrawork    # Implement with parallel agents
/ultraqa      # Test and fix until passing
```

### Debugging
```
/note Found bug in auth flow
/analyze      # Deep investigation
/note --priority Auth uses JWT in src/auth/jwt.ts
```

### Documentation
```
/deepinit     # Generate AGENTS.md hierarchy
/note --show  # Review accumulated context
```

## Need More Help?

- **README**: Full documentation at https://github.com/Yeachan-Heo/oh-my-claudecode
- **Issues**: Report bugs at https://github.com/Yeachan-Heo/oh-my-claudecode/issues
- **Examples**: See examples/ directory in plugin

## Version

Current version: 2.6.1

---

*Tip: Most commands accept arguments. Try `/command --help` or just `/command <your request>` to get started!*
