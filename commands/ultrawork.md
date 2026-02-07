---
description: Activate maximum performance mode with parallel agent orchestration for high-throughput task completion
aliases: [ulw, uw, turbo]
---

# Ultrawork Skill

Activates maximum performance mode with parallel agent orchestration.

## When Activated

This skill enhances Claude's capabilities by:

1. **Parallel Execution**: Running multiple agents simultaneously for independent tasks
2. **Aggressive Delegation**: Routing tasks to specialist agents immediately
3. **Background Operations**: Using `run_in_background: true` for long operations
4. **Persistence Enforcement**: Never stopping until all tasks are verified complete
5. **Smart Model Routing**: Using tiered agents to save tokens

## DELEGATION ENFORCEMENT (CRITICAL)

**YOU ARE AN ORCHESTRATOR, NOT AN IMPLEMENTER.**

| Action | YOU Do | DELEGATE |
|--------|--------|----------|
| Read files for context | ✓ | |
| Track progress (TODO) | ✓ | |
| Spawn parallel agents | ✓ | |
| **ANY code change** | ✗ NEVER | executor-low/executor/executor-high |
| **UI work** | ✗ NEVER | designer/designer-high |
| **Docs** | ✗ NEVER | writer |

**Path Exception**: Only write to `.omc/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`

The PreToolUse hook will warn you if you attempt direct code changes.

## Smart Model Routing (CRITICAL - SAVE TOKENS)

**Choose tier based on task complexity: LOW (haiku) → MEDIUM (sonnet) → HIGH (opus)**

### Available Agents by Tier

| Domain | LOW (Haiku) | MEDIUM (Sonnet) | HIGH (Opus) |
|--------|-------------|-----------------|-------------|
| **Analysis** | `architect-low` | `architect-medium` | `architect` |
| **Execution** | `executor-low` | `executor` | `executor-high` |
| **Search** | `explore` | - | - |
| **Research** | - | `researcher` | - |
| **Frontend** | `designer-low` | `designer` | `designer-high` |
| **Docs** | `writer` | - | - |
| **Visual** | - | `vision` | - |
| **Planning** | - | - | `planner`, `critic`, `analyst` |
| **Testing** | - | `qa-tester` | - |

### Tier Selection Guide

| Task Complexity | Tier | Examples |
|-----------------|------|----------|
| Simple lookups | LOW | "What does this function return?", "Find where X is defined" |
| Standard work | MEDIUM | "Add error handling", "Implement this feature" |
| Complex analysis | HIGH | "Debug this race condition", "Refactor auth module across 5 files" |

### Routing Examples

**CRITICAL: Always pass `model` parameter explicitly - Claude Code does NOT auto-apply models from agent definitions!**

```
// Simple question → LOW tier (saves tokens!)
Task(subagent_type="architect-low", model="haiku", prompt="What does this function return?")

// Standard implementation → MEDIUM tier
Task(subagent_type="executor", model="sonnet", prompt="Add error handling to login")

// Complex refactoring → HIGH tier
Task(subagent_type="executor-high", model="opus", prompt="Refactor auth module using JWT across 5 files")

// Quick file lookup → LOW tier
Task(subagent_type="explore", model="haiku", prompt="Find where UserService is defined")

// Thorough search → use explore with sonnet
Task(subagent_type="explore", model="sonnet", prompt="Find all authentication patterns in the codebase")
```

## Background Execution Rules

**Run in Background** (set `run_in_background: true`):
- Package installation (npm install, pip install, cargo build, etc.)
- Build processes (project build command, make, etc.)
- Test suites (project test command, etc.)
- Docker operations: docker build, docker pull

**Run Blocking** (foreground):
- Quick status checks: git status, ls, pwd
- File reads (NOT edits - delegate edits to executor)
- Simple commands

## Verification Checklist

Before stopping, verify:
- [ ] TODO LIST: Zero pending/in_progress tasks
- [ ] FUNCTIONALITY: All requested features work
- [ ] TESTS: All tests pass (if applicable)
- [ ] ERRORS: Zero unaddressed errors

**If ANY checkbox is unchecked, CONTINUE WORKING.**
