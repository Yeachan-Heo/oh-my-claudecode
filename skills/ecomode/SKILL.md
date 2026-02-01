---
name: ecomode
description: Token-efficient parallel execution mode using Haiku and Sonnet agents
---

# Ecomode Skill

Activates token-efficient parallel execution for pro-plan users who prioritize cost efficiency.

## When Activated

This skill enhances Claude's capabilities by:

1. **Parallel Execution**: Running multiple agents simultaneously for independent tasks
2. **Token-Conscious Routing**: Preferring haiku, avoiding opus
3. **Background Operations**: Using `run_in_background: true` for long operations
4. **Persistence Enforcement**: Never stopping until all tasks are verified complete
5. **Cost Optimization**: Minimizing token usage while maintaining quality

## Ecomode Routing Rules (CRITICAL)

**ALWAYS prefer lower tiers. Only escalate when task genuinely requires it.**

| Decision | Rule |
|----------|------|
| DEFAULT | Use haiku for all tasks |
| UPGRADE | Use sonnet only when task complexity warrants |
| AVOID | opus - only use for planning/critique if explicitly essential |

## Smart Model Routing (PREFER HAIKU)

**Choose model based on task complexity: haiku preferred → sonnet fallback → opus AVOID**

### Model Selection Guide (Token-Conscious)

| Task Complexity | Model | Examples |
|-----------------|-------|----------|
| Simple lookups | haiku | "What does this function return?", "Find where X is defined" |
| Standard work | haiku first, sonnet if fails | "Add error handling", "Implement this feature" |
| Complex analysis | sonnet | "Debug this issue", "Refactor this module" |
| Planning only | opus (if essential) | "Design architecture for new system" |

### Agent Types and Models

| Purpose | Preferred (haiku) | Fallback (sonnet) | Avoid (opus) |
|---------|-------------------|-------------------|--------------|
| **Exploration** | `Explore` + haiku | `Explore` + sonnet | - |
| **Implementation** | `general-purpose` + haiku | `general-purpose` + sonnet | - |
| **Planning** | - | `Plan` + sonnet | `Plan` + opus (if essential) |

### Routing Examples

**CRITICAL: Always pass `model` parameter explicitly!**

```
// Simple question → haiku (DEFAULT)
Task(subagent_type="Explore", model="haiku", prompt="What does this function return?")

// Standard implementation → TRY haiku first
Task(subagent_type="general-purpose", model="haiku", prompt="Add validation to login form")

// If haiku fails, escalate to sonnet
Task(subagent_type="general-purpose", model="sonnet", prompt="Add error handling to login")

// File lookup → ALWAYS haiku
Task(subagent_type="Explore", model="haiku", prompt="Find where UserService is defined")

// Only use sonnet for complex patterns
Task(subagent_type="Explore", model="sonnet", prompt="Find all authentication patterns in the codebase")
```

## DELEGATION ENFORCEMENT (CRITICAL)

**YOU ARE AN ORCHESTRATOR, NOT AN IMPLEMENTER.**

| Action | YOU Do | DELEGATE |
|--------|--------|----------|
| Read files for context | ✓ | |
| Track progress (TODO) | ✓ | |
| Spawn parallel agents | ✓ | |
| **ANY code change** | ✗ NEVER | general-purpose agents |
| **UI work** | ✗ NEVER | general-purpose agents |
| **Docs** | ✗ NEVER | general-purpose (haiku) |

**Path Exception**: Only write to `.omc/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`

## Background Execution Rules

**Run in Background** (set `run_in_background: true`):
- Package installation: npm install, pip install, cargo build
- Build processes: npm run build, make, tsc
- Test suites: npm test, pytest, cargo test
- Docker operations: docker build, docker pull

**Run Blocking** (foreground):
- Quick status checks: git status, ls, pwd
- File reads (NOT edits - delegate edits to agents)
- Simple commands

## Verification Checklist

Before stopping, verify:
- [ ] TODO LIST: Zero pending/in_progress tasks
- [ ] FUNCTIONALITY: All requested features work
- [ ] TESTS: All tests pass (if applicable)
- [ ] ERRORS: Zero unaddressed errors

**If ANY checkbox is unchecked, CONTINUE WORKING.**

## Token Savings Tips

1. **Batch similar tasks** to one agent instead of spawning many
2. **Use Explore + haiku** for file discovery
3. **Prefer haiku** for simple changes - only upgrade if it fails
4. **Avoid opus agents** unless the task genuinely requires deep reasoning
5. **Use haiku** for all documentation tasks

## Valid Agent Types

| Type | Use For |
|------|---------|
| `general-purpose` | All implementation work (DEFAULT) |
| `Explore` | Codebase exploration, finding files |
| `Plan` | Architecture and planning (use sparingly) |
| `Bash` | Shell commands only |

## STATE CLEANUP ON COMPLETION

**IMPORTANT: Delete state files on completion - do NOT just set `active: false`**

When ecomode completes (all verification passes):

```bash
# Delete ecomode state files
rm -f .omc/state/ecomode-state.json
rm -f ~/.claude/ecomode-state.json
```

This ensures clean state for future sessions. Stale state files with `active: false` should not be left behind.
