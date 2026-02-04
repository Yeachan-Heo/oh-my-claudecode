<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-01-31 -->

# hooks

31 event-driven hooks that power execution modes and behaviors.

## Purpose

Hooks intercept Claude Code events to enable:
- **Execution modes**: autopilot, ultrawork, ralph, ultrapilot, swarm, pipeline (ecomode via mode-registry)
- **Validation**: thinking blocks, empty messages, comments
- **Recovery**: edit errors, session recovery, context window
- **Enhancement**: rules injection, directory READMEs, notepad
- **Detection**: keywords, think mode, slash commands

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Re-exports all hooks |
| `bridge.ts` | Shell script entry point - `processHook()` routes events to handlers |

## Subdirectories

### Execution Mode Hooks

| Directory | Purpose | Trigger |
|-----------|---------|---------|
| `autopilot/` | Full autonomous execution | "autopilot", "build me" |
| `ultrawork/` | Maximum parallel execution | "ulw", "ultrawork" |
| `ralph/` | Persistence until verified | "ralph", "don't stop" |
| `ultrapilot/` | Parallel autopilot with file ownership | "ultrapilot" |
| `swarm/` | N coordinated agents with task claiming | "swarm N agents" |
| `ultraqa/` | QA cycling until goal met | test failures |
| `mode-registry/` | Tracks active execution mode (incl. ecomode) | internal |
| `persistent-mode/` | Maintains mode state across sessions | internal |

### Validation Hooks

| Directory | Purpose |
|-----------|---------|
| `thinking-block-validator/` | Validates thinking blocks in responses |
| `empty-message-sanitizer/` | Handles empty/whitespace messages |
| `comment-checker/` | Checks code comment quality |
| `permission-handler/` | Handles permission requests and validation |

### Recovery Hooks

| Directory | Purpose |
|-----------|---------|
| `recovery/` | Edit error recovery, session recovery |
| `preemptive-compaction/` | Prevents context overflow |
| `pre-compact/` | Pre-compaction processing |

### Enhancement Hooks

| Directory | Purpose |
|-----------|---------|
| `rules-injector/` | Injects matching rule files |
| `directory-readme-injector/` | Injects directory READMEs |
| `notepad/` | Persists notes for compaction resilience |
| `learner/` | Skill extraction from conversations |
| `agent-usage-reminder/` | Reminds about agent delegation |

### Detection Hooks

| Directory | Purpose |
|-----------|---------|
| `keyword-detector/` | Magic keyword detection |
| `think-mode/` | Extended thinking detection |
| `auto-slash-command/` | Slash command expansion |
| `non-interactive-env/` | Non-interactive environment detection |
| `plugin-patterns/` | Plugin pattern detection |

### Coordination Hooks

| Directory | Purpose |
|-----------|---------|
| `todo-continuation/` | Enforces task completion |
| `omc-orchestrator/` | Orchestrator behavior |
| `subagent-tracker/` | Tracks spawned sub-agents |
| `session-end/` | Session termination handling |
| `background-notification/` | Background task notifications |

### Setup Hooks

| Directory | Purpose |
|-----------|---------|
| `setup/` | Initial setup and configuration |

## For AI Agents

### Working In This Directory

#### Hook Structure

Each hook follows a standard pattern:
```
hook-name/
├── index.ts     # Main hook implementation
├── types.ts     # TypeScript interfaces
├── constants.ts # Configuration constants
└── *.ts         # Supporting modules
```

#### When Adding a New Hook

1. Create hook directory with `index.ts`, `types.ts`, `constants.ts`
2. Export from `index.ts` (hook re-exports)
3. Register handler in `bridge.ts` if needed
4. Update `docs/REFERENCE.md` (Hooks System section) with new hook entry
5. If execution mode hook, also create `skills/*/SKILL.md` and `commands/*.md`

#### Hook Implementation

```typescript
// index.ts
export interface HookConfig {
  enabled: boolean;
  // hook-specific config
}

export function createHook(config: HookConfig) {
  return {
    name: 'hook-name',
    event: 'UserPromptSubmit',  // or 'Stop', 'PreToolUse', 'PostToolUse'
    handler: async (context) => {
      // Hook logic
      return { modified: false };
    }
  };
}
```

#### Key Hooks Explained

**autopilot/** - Full autonomous execution:
- Validates goals and creates plans
- Manages execution state
- Handles cancellation
- Enforces completion

**ralph/** - Persistence mechanism:
- Tracks progress via PRD
- Spawns architect for verification
- Loops until verified complete
- Supports structured PRD format

**ultrapilot/** - Parallel autopilot:
- Decomposes tasks into subtasks
- Assigns file ownership to workers
- Coordinates parallel execution
- Integrates results

**swarm/** - Coordinated multi-agent:
- SQLite-based task claiming
- 5-minute timeout per task
- Atomic claim/release
- Clean completion detection

**learner/** - Skill extraction:
- Detects skill patterns in conversation
- Extracts to local skill files
- Auto-invokes matching skills
- Manages skill lifecycle

### Common Patterns

#### State Management

```typescript
import { readState, writeState } from '../features/state-manager';

const state = readState('autopilot-state');
state.phase = 'executing';
writeState('autopilot-state', state);
```

#### Event Handling

```typescript
// UserPromptSubmit - Before prompt is sent
// Stop - Before session ends
// PreToolUse - Before tool execution
// PostToolUse - After tool execution
```

### Testing Requirements

- Test specific hooks with `npm test -- --grep "hook-name"`
- Test execution modes end-to-end with skill invocation
- Verify state persistence in `.omc/state/`
- For security hooks, follow `templates/rules/security.md` checklist

## Dependencies

### Internal
- `features/state-manager/` for state persistence
- `features/verification/` for verification protocol
- `agents/` for spawning sub-agents

### External
| Package | Purpose |
|---------|---------|
| `better-sqlite3` | Swarm task coordination |
| `fs`, `path` | State file operations |

## Hook Events

| Event | When Fired | Common Uses |
|-------|------------|-------------|
| `UserPromptSubmit` | Before prompt processing | Keyword detection, mode activation |
| `Stop` | Before session ends | Continuation enforcement |
| `PreToolUse` | Before tool execution | Permission validation |
| `PostToolUse` | After tool execution | Error recovery, rules injection |

### Stop Hook Output Contract

The persistent-mode stop hook uses **soft enforcement**:

```typescript
// Stop hook ALWAYS returns continue: true
// Enforcement is via message injection, not blocking
return {
  continue: true,
  message: result.message || undefined  // Injected into context
};
```

**Why soft enforcement**: Hard blocking (`continue: false`) would prevent context compaction and could deadlock Claude Code.

**Bypass conditions** (checked first, allow stopping):
1. `context-limit` - Context window exhausted, must allow compaction
2. `user-abort` - User explicitly requested stop

**Mode priority** (checked after bypass, may inject continuation message):
1. Ralph (explicit persistence loop)
2. Autopilot (full orchestration)
3. Ultrapilot (parallel workers)
4. Swarm (coordinated agents)
5. Pipeline (sequential stages)
6. UltraQA (test cycling)
7. Ultrawork (parallel execution)
8. Ecomode (token-efficient)

**Session isolation**: Hooks only enforce for matching `session_id`. Stale states (>2 hours) are ignored.

**Mode completion criteria**: Hook blocks while `state.active === true && state.session_id === currentSession && !isStaleState()`. Running `/cancel` sets `active: false` and removes state files.

## State Files

| Hook | State File |
|------|------------|
| autopilot | `.omc/state/autopilot-state.json` |
| ultrapilot | `.omc/state/ultrapilot-state.json` |
| ralph | `.omc/state/ralph-state.json` |
| swarm | `.omc/state/swarm-tasks.db` (SQLite) |
| learner | `~/.claude/local-skills/` |

<!-- MANUAL: -->
