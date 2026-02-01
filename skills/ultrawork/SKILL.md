---
name: ultrawork
description: Activate maximum performance mode with parallel agent orchestration for high-throughput task completion
---

# Ultrawork Skill

Activates maximum performance mode with parallel agent orchestration.

## When Activated

This skill enhances Claude's capabilities by:

1. **Parallel Execution**: Running multiple agents simultaneously for independent tasks
2. **Aggressive Delegation**: Routing tasks to agents immediately
3. **Background Operations**: Using `run_in_background: true` for long operations
4. **Persistence Enforcement**: Never stopping until all tasks are verified complete
5. **Smart Model Routing**: Using tiered models to save tokens

## Smart Model Routing (CRITICAL - SAVE TOKENS)

**Choose model based on task complexity: haiku → sonnet → opus**

### Model Selection Guide

| Task Complexity | Model | Examples |
|-----------------|-------|----------|
| Simple lookups | haiku | "What does this function return?", "Find where X is defined" |
| Standard work | sonnet | "Add error handling", "Implement this feature" |
| Complex analysis | opus | "Debug this race condition", "Refactor auth module across 5 files" |

### Agent Types and Models

| Purpose | Agent Type | Model |
|---------|------------|-------|
| **Codebase Exploration** | `Explore` | haiku or sonnet |
| **Architecture/Planning** | `Plan` | sonnet or opus |
| **Implementation** | `general-purpose` | haiku/sonnet/opus based on complexity |
| **Shell Commands** | `Bash` | N/A |

### Routing Examples

**CRITICAL: Always pass `model` parameter explicitly!**

```
// Simple question → haiku (saves tokens!)
Task(subagent_type="Explore", model="haiku", prompt="What does this function return?")

// Standard implementation → sonnet
Task(subagent_type="general-purpose", model="sonnet", prompt="Add error handling to login")

// Complex refactoring → opus
Task(subagent_type="general-purpose", model="opus", prompt="Refactor auth module using JWT across 5 files")

// Quick file lookup → haiku
Task(subagent_type="Explore", model="haiku", prompt="Find where UserService is defined")

// Thorough search → sonnet
Task(subagent_type="Explore", model="sonnet", prompt="Find all authentication patterns in the codebase")

// Architecture planning → opus
Task(subagent_type="Plan", model="opus", prompt="Design the database schema for user management")
```

## Background Execution Rules

**Run in Background** (set `run_in_background: true`):
- Package installation: npm install, pip install, cargo build
- Build processes: npm run build, make, tsc
- Test suites: npm test, pytest, cargo test
- Docker operations: docker build, docker pull

**Run Blocking** (foreground):
- Quick status checks: git status, ls, pwd
- File reads, edits
- Simple commands

## Verification Checklist

Before stopping, verify:
- [ ] TODO LIST: Zero pending/in_progress tasks
- [ ] FUNCTIONALITY: All requested features work
- [ ] TESTS: All tests pass (if applicable)
- [ ] ERRORS: Zero unaddressed errors

**If ANY checkbox is unchecked, CONTINUE WORKING.**

## Valid Agent Types

| Type | Use For |
|------|---------|
| `general-purpose` | All implementation work (DEFAULT) |
| `Explore` | Codebase exploration, finding files |
| `Plan` | Architecture and planning |
| `Bash` | Shell commands only |

## STATE CLEANUP ON COMPLETION

**IMPORTANT: Delete state files on completion - do NOT just set `active: false`**

When all verification passes and work is complete:

```bash
# Delete ultrawork state files
rm -f .omc/state/ultrawork-state.json
rm -f ~/.claude/ultrawork-state.json
```

This ensures clean state for future sessions. Stale state files with `active: false` should not be left behind.
