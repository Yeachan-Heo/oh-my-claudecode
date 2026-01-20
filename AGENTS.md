# PROJECT KNOWLEDGE BASE

**Project:** oh-my-claudecode
**Version:** 3.0.0-beta
**Purpose:** Multi-agent orchestration system for Claude Code CLI
**Inspired by:** oh-my-opencode

## OVERVIEW

oh-my-claudecode is an enhancement system for Claude Code (Anthropic's official CLI) that adds multi-agent orchestration, persistence mechanisms, and advanced productivity features. Think "oh-my-zsh" for Claude Code.

**Key Features:**
- **🚀 NEW: Intelligent Model Routing** - Orchestrator analyzes complexity and routes to optimal model (Haiku/Sonnet/Opus)
- Multi-agent orchestration with specialized subagents
- Persistent work loops (Ralph Loop)
- State management for complex plans
- Magic keyword detection (ultrawork, ultrathink, analyze, search)
- Todo continuation enforcement
- Rules injection from project/user config
- Automatic edit error recovery

## v2.0 INTELLIGENT MODEL ROUTING

The orchestrator (always Opus) analyzes task complexity BEFORE delegation:

| Task Type | Routes To | Example |
|-----------|-----------|---------|
| Simple lookup | **Haiku** | "Where is auth configured?" |
| Module work | **Sonnet** | "Add validation to login form" |
| Complex/risky | **Opus** | "Debug this race condition" |

**All agents are adaptive** (except orchestrators). See `src/features/model-routing/` for implementation.

## STRUCTURE

```
oh-my-claudecode/
├── src/
│   ├── agents/              # 12 agent definitions
│   │   ├── definitions.ts   # Agent registry & configs
│   │   ├── types.ts         # Agent type definitions
│   │   ├── utils.ts         # Shared utilities
│   │   ├── architect.ts     # Complex debugging/architecture
│   │   ├── explore.ts       # Fast codebase search
│   │   ├── researcher.ts    # Documentation research
│   │   ├── executor.ts      # Focused execution
│   │   ├── designer.ts      # UI/UX work
│   │   ├── writer.ts        # Technical docs
│   │   ├── vision.ts        # Visual analysis
│   │   ├── critic.ts        # Critical plan review
│   │   ├── analyst.ts       # Pre-planning analysis
│   │   ├── orchestrator.ts  # Todo coordination
│   │   ├── planner.ts       # Strategic planning
│   │   └── qa-tester.ts     # CLI/service testing with tmux
│   ├── hooks/               # 8 hook modules
│   │   ├── keyword-detector/    # Magic keyword detection
│   │   ├── ralph-loop/          # Self-referential work loops
│   │   ├── todo-continuation/   # Task completion enforcement
│   │   ├── edit-error-recovery/ # Edit failure handling
│   │   ├── think-mode/          # Enhanced thinking modes
│   │   ├── rules-injector/      # Rule file injection
│   │   ├── orchestrator/        # Orchestrator behavior
│   │   ├── auto-slash-command/  # Slash command detection
│   │   └── bridge.ts            # Shell hook bridge
│   ├── features/            # 6 feature modules
│   │   ├── model-routing/       # 🆕 v2.0: Intelligent model routing
│   │   │   ├── types.ts         # Routing types & config
│   │   │   ├── signals.ts       # Complexity signal extraction
│   │   │   ├── scorer.ts        # Weighted complexity scoring
│   │   │   ├── rules.ts         # Routing rules engine
│   │   │   ├── router.ts        # Main routing logic
│   │   │   └── prompts/         # Tier-specific prompt adaptations
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
└── .omc/                    # Runtime state directory
    ├── plans/               # Planner plans
    └── notepads/            # Session notes
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add agent | `src/agents/` | Create .ts, add to agentDefinitions in definitions.ts |
| Add hook | `src/hooks/` | Create dir, export from index.ts, add to bridge.ts |
| Add feature | `src/features/` | Create dir, export from index.ts |
| Add skill | `src/installer/index.ts` | Add to SKILL_DEFINITIONS |
| Agent types | `src/agents/types.ts` | AgentDefinition, AgentMetadata interfaces |
| Hook types | `src/hooks/<name>/types.ts` | Hook-specific types |
| State mgmt | `src/features/boulder-state/` | Plan state and progress tracking |
| Background tasks | `src/features/background-agent/` | BackgroundManager class |
| Shell hooks | `src/hooks/bridge.ts` | processHook() entry point |

## AGENTS

| Agent | Model | Purpose | Key Traits |
|-------|-------|---------|------------|
| **architect** | Opus | Architecture, debugging | Deep analysis, root cause finding |
| **researcher** | Sonnet | Documentation, research | Multi-repo analysis, doc lookup |
| **explore** | Haiku | Fast codebase search | Quick pattern matching |
| **executor** | Sonnet | Focused execution | Direct task implementation |
| **designer** | Sonnet | UI/UX work | Component design, styling |
| **writer** | Haiku | Technical docs | README, API docs |
| **vision** | Sonnet | Visual analysis | Screenshots, diagrams |
| **critic** | Opus | Plan review | Critical evaluation |
| **analyst** | Opus | Pre-planning | Hidden requirements |
| **orchestrator** | Sonnet | Todo coordination | Task delegation |
| **planner** | Opus | Strategic planning | Interview-style planning |
| **qa-tester** | Sonnet | CLI/service testing | Interactive tmux testing |

## HOOKS

| Hook | Event | Purpose |
|------|-------|---------|
| **keyword-detector** | UserPromptSubmit | Detect ultrawork/ultrathink/search/analyze |
| **ralph-loop** | Stop | Enforce work continuation until completion |
| **todo-continuation** | Stop | Block stop if todos remain |
| **edit-error-recovery** | PostToolUse | Inject recovery hints on edit failures |
| **think-mode** | UserPromptSubmit | Activate extended thinking |
| **rules-injector** | PostToolUse (Read/Edit) | Inject matching rule files |
| **orchestrator** | PreToolUse, PostToolUse | Enforce delegation, add verification |
| **auto-slash-command** | UserPromptSubmit | Detect and expand /commands |

## SKILLS

| Skill | Description |
|-------|-------------|
| **orchestrator** | Master coordinator for complex tasks |
| **default** | Multi-agent orchestration mode |
| **ralph-loop** | Self-referential loop until completion |
| **frontend-ui-ux** | Designer-turned-developer aesthetic |
| **git-master** | Atomic commits, rebasing, history search |
| **ultrawork** | Maximum performance parallel mode |

## CONVENTIONS

- **Runtime**: Node.js (not Bun)
- **Build**: TypeScript with ESM output
- **Package**: npm
- **Testing**: Manual verification (no test framework)
- **Hooks**: Shell-based (Claude Code native)
- **State**: JSON files in `~/.claude/.omc/`
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
npm run build        # Build TypeScript
npm run typecheck    # Type check only
npm run install:dev  # Install to ~/.claude
```

## STATE FILES

| File | Purpose |
|------|---------|
| `~/.claude/.omc/plan-state.json` | Active plan state |
| `~/.claude/.omc/ralph.json` | Ralph Loop state |
| `~/.claude/.omc/rules-injector/*.json` | Injected rules tracking |
| `~/.claude/.omc/background-tasks/*.json` | Background task state |

## CONFIGURATION

Settings live in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      "~/.claude/omc/hooks/keyword-detector.sh"
    ],
    "Stop": [
      "~/.claude/omc/hooks/todo-continuation.sh"
    ]
  }
}
```

## SLASH COMMANDS

| Command | Description |
|---------|-------------|
| `/default <task>` | Activate multi-agent orchestration |
| `/ultrawork <task>` | Maximum performance mode |
| `/plan <description>` | Start planning with Planner |
| `/review [plan]` | Review plan with Critic |
| `/ralph-loop <task>` | Self-referential loop |
| `/cancel-ralph` | Cancel active Ralph Loop |
| `/orchestrator <task>` | Complex task coordination |
| `/deepsearch <query>` | Thorough codebase search |
| `/analyze <target>` | Deep analysis |

## COMPLEXITY HOTSPOTS

| File | Lines | Description |
|------|-------|-------------|
| `src/installer/index.ts` | 2000+ | SKILL_DEFINITIONS, CLAUDE_MD_CONTENT |
| `src/agents/definitions.ts` | 600+ | All agent configurations |
| `src/hooks/bridge.ts` | 320+ | Main hook processor |
| `src/features/boulder-state/storage.ts` | 200+ | Plan state management |

## NOTES

- **Claude Code Version**: Requires Claude Code CLI
- **Installation**: `npx oh-my-claudecode install`
- **Updates**: Silent auto-update checks
- **Compatibility**: Designed for Claude Code, not OpenCode
- **State Persistence**: Uses ~/.claude/.omc/ directory
- **Hook System**: Shell scripts → TypeScript bridge → JSON output
