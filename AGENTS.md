# PROJECT KNOWLEDGE BASE

**Project:** Oh-My-ClaudeCode-Sisyphus
**Purpose:** Multi-agent orchestration system for Claude Code CLI
**Inspired by:** oh-my-opencode

## OVERVIEW

Oh-My-ClaudeCode-Sisyphus is an enhancement system for Claude Code (Anthropic's official CLI) that adds multi-agent orchestration, persistence mechanisms, and advanced productivity features. Think "oh-my-zsh" for Claude Code.

**Key Features:**

- Multi-agent orchestration with specialized subagents
- Persistent work loops (Ralph Loop)
- Boulder state management for complex plans
- Magic keyword detection (ultrawork, ultrathink, analyze, search)
- Todo continuation enforcement
- Rules injection from project/user config
- Automatic edit error recovery

## STRUCTURE

```
oh-my-claude-sisyphus/
├── src/
│   ├── agents/              # 15 agent definitions
│   │   ├── definitions.ts   # Agent registry & configs
│   │   ├── types.ts         # Agent type definitions
│   │   ├── utils.ts         # Shared utilities
│   │   ├── oracle.ts        # Complex debugging/architecture
│   │   ├── explore.ts       # Fast codebase search
│   │   ├── librarian.ts     # Documentation research
│   │   ├── sisyphus-junior.ts  # Focused execution
│   │   ├── frontend-engineer.ts # UI/UX work
│   │   ├── document-writer.ts   # Technical docs
│   │   ├── multimodal-looker.ts # Visual analysis
│   │   ├── momus.ts         # Critical plan review
│   │   ├── metis.ts         # Pre-planning analysis
│   │   ├── orchestrator-sisyphus.ts  # Todo coordination
│   │   └── prometheus.ts    # Strategic planning
│   ├── hooks/               # 8 hook modules
│   │   ├── keyword-detector/    # Magic keyword detection
│   │   ├── ralph-loop/          # Self-referential work loops
│   │   ├── todo-continuation/   # Task completion enforcement
│   │   ├── edit-error-recovery/ # Edit failure handling
│   │   ├── think-mode/          # Enhanced thinking modes
│   │   ├── rules-injector/      # Rule file injection
│   │   ├── sisyphus-orchestrator/ # Orchestrator behavior
│   │   ├── auto-slash-command/  # Slash command detection
│   │   └── bridge.ts            # Shell hook bridge
│   ├── features/            # 5 feature modules
│   │   ├── boulder-state/       # Plan state management
│   │   ├── context-injector/    # Context enhancement
│   │   ├── background-agent/    # Background task management
│   │   ├── builtin-skills/      # Bundled skill definitions
│   │   ├── magic-keywords.ts    # Keyword processing
│   │   ├── continuation-enforcement.ts
│   │   └── auto-update.ts       # Silent auto-update
│   ├── installer/           # Installation system
│   │   ├── index.ts         # Main installer (SKILL_DEFINITIONS, etc.)
│   │   └── hooks.ts         # Hook generation
│   └── index.ts             # Main exports
├── dist/                    # Build output (ESM)
└── .sisyphus/               # Runtime state directory
    ├── plans/               # Prometheus plans
    └── notepads/            # Session notes
```

## WHERE TO LOOK

| Task             | Location                         | Notes                                                 |
| ---------------- | -------------------------------- | ----------------------------------------------------- |
| Add agent        | `src/agents/`                    | Create .ts, add to agentDefinitions in definitions.ts |
| Add hook         | `src/hooks/`                     | Create dir, export from index.ts, add to bridge.ts    |
| Add feature      | `src/features/`                  | Create dir, export from index.ts                      |
| Add skill        | `src/installer/index.ts`         | Add to SKILL_DEFINITIONS                              |
| Agent types      | `src/agents/types.ts`            | AgentDefinition, AgentMetadata interfaces             |
| Hook types       | `src/hooks/<name>/types.ts`      | Hook-specific types                                   |
| State mgmt       | `src/features/boulder-state/`    | BoulderState, plan progress                           |
| Background tasks | `src/features/background-agent/` | BackgroundManager class                               |
| Shell hooks      | `src/hooks/bridge.ts`            | processHook() entry point                             |

## AGENTS

| Agent                     | Model  | Purpose                 | Key Traits                        |
| ------------------------- | ------ | ----------------------- | --------------------------------- |
| **oracle**                | Opus   | Architecture, debugging | Deep analysis, root cause finding |
| **librarian**             | Sonnet | Documentation, research | Multi-repo analysis, doc lookup   |
| **explore**               | Haiku  | Fast codebase search    | Quick pattern matching            |
| **sisyphus-junior**       | Sonnet | Focused execution       | Direct task implementation        |
| **frontend-engineer**     | Sonnet | UI/UX work              | Component design, styling         |
| **document-writer**       | Haiku  | Technical docs          | README, API docs                  |
| **multimodal-looker**     | Sonnet | Visual analysis         | Screenshots, diagrams             |
| **momus**                 | Opus   | Plan review             | Critical evaluation               |
| **metis**                 | Opus   | Pre-planning            | Hidden requirements               |
| **orchestrator-sisyphus** | Sonnet | Todo coordination       | Task delegation                   |
| **prometheus**            | Opus   | Strategic planning      | Interview-style planning          |

## HOOKS

| Hook                      | Event                   | Purpose                                    |
| ------------------------- | ----------------------- | ------------------------------------------ |
| **keyword-detector**      | UserPromptSubmit        | Detect ultrawork/ultrathink/search/analyze |
| **ralph-loop**            | Stop                    | Enforce work continuation until completion |
| **todo-continuation**     | Stop                    | Block stop if todos remain                 |
| **edit-error-recovery**   | PostToolUse             | Inject recovery hints on edit failures     |
| **think-mode**            | UserPromptSubmit        | Activate extended thinking                 |
| **rules-injector**        | PostToolUse (Read/Edit) | Inject matching rule files                 |
| **sisyphus-orchestrator** | PreToolUse, PostToolUse | Enforce delegation, add verification       |
| **auto-slash-command**    | UserPromptSubmit        | Detect and expand /commands                |

## SKILLS

| Skill              | Description                              |
| ------------------ | ---------------------------------------- |
| **orchestrator**   | Master coordinator for complex tasks     |
| **sisyphus**       | Multi-agent orchestration mode           |
| **ralph-loop**     | Self-referential loop until completion   |
| **frontend-ui-ux** | Designer-turned-developer aesthetic      |
| **git-master**     | Atomic commits, rebasing, history search |
| **ultrawork**      | Maximum performance parallel mode        |

## CONVENTIONS

- **Runtime**: Bun
- **Build**: TypeScript with ESM output
- **Package**: bun
- **Testing**: Manual verification (no test framework)
- **Hooks**: Shell-based (Claude Code native)
- **State**: JSON files in `~/.claude/.sisyphus/`
- **Naming**: kebab-case directories, createXXXHook factories

## ANTI-PATTERNS

- **Direct implementation by orchestrator**: Must delegate via Task tool
- **Skipping verification**: Always verify subagent claims
- **Sequential when parallel possible**: Use multiple Task calls
- **Batching todos**: Mark complete immediately
- **Giant commits**: 3+ files = 2+ commits minimum
- **Trusting self-reports**: Verify with own tool calls
- **Stopping with incomplete todos**: Ralph Loop prevents this

## COMMANDS

```bash
bun run build        # Build TypeScript
bun run typecheck    # Type check only
bun run install:dev  # Install to ~/.claude
```

## STATE FILES

| File                                          | Purpose                 |
| --------------------------------------------- | ----------------------- |
| `~/.claude/.sisyphus/boulder.json`            | Active plan state       |
| `~/.claude/.sisyphus/ralph.json`              | Ralph Loop state        |
| `~/.claude/.sisyphus/rules-injector/*.json`   | Injected rules tracking |
| `~/.claude/.sisyphus/background-tasks/*.json` | Background task state   |

## CONFIGURATION

Settings live in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": ["~/.claude/sisyphus/hooks/keyword-detector.sh"],
    "Stop": ["~/.claude/sisyphus/hooks/todo-continuation.sh"]
  }
}
```

## SLASH COMMANDS

| Command                | Description                        |
| ---------------------- | ---------------------------------- |
| `/sisyphus <task>`     | Activate multi-agent orchestration |
| `/ultrawork <task>`    | Maximum performance mode           |
| `/plan <description>`  | Start planning with Prometheus     |
| `/review [plan]`       | Review plan with Momus             |
| `/ralph-loop <task>`   | Self-referential loop              |
| `/cancel-ralph`        | Cancel active Ralph Loop           |
| `/orchestrator <task>` | Complex task coordination          |
| `/deepsearch <query>`  | Thorough codebase search           |
| `/analyze <target>`    | Deep analysis                      |
| `/update`              | Check for updates                  |

## COMPLEXITY HOTSPOTS

| File                                    | Lines | Description                          |
| --------------------------------------- | ----- | ------------------------------------ |
| `src/installer/index.ts`                | 2000+ | SKILL_DEFINITIONS, CLAUDE_MD_CONTENT |
| `src/agents/definitions.ts`             | 600+  | All agent configurations             |
| `src/hooks/bridge.ts`                   | 320+  | Main hook processor                  |
| `src/features/boulder-state/storage.ts` | 200+  | Plan state management                |

## NOTES

- **Claude Code Version**: Requires Claude Code CLI
- **Installation**: `npx oh-my-claude-sisyphus install`
- **Updates**: Silent auto-update checks
- **Compatibility**: Designed for Claude Code, not OpenCode
- **State Persistence**: Uses ~/.claude/.sisyphus/ directory
- **Hook System**: Shell scripts → TypeScript bridge → JSON output
