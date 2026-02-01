---
name: ultrawork
description: Parallel execution engine for high-throughput task completion
---

# Ultrawork Skill

Parallel execution engine. This is a **COMPONENT**, not a standalone persistence mode.

## What Ultrawork Provides

1. **Parallel Execution**: Running multiple agents simultaneously for independent tasks
2. **Background Operations**: Using `run_in_background: true` for long operations
3. **Smart Model Routing**: Using tiered agents to save tokens

## What Ultrawork Does NOT Provide

- **Persistence**: Use `ralph` for "don't stop until done" behavior
- **Verification Loop**: Use `ralph` for mandatory architect verification
- **State Management**: Use `ralph` or `autopilot` for session persistence

## Usage

Ultrawork is automatically activated by:
- `ralph` (for persistent parallel work)
- `autopilot` (for autonomous parallel work)
- Direct invocation when you want parallel-only execution with manual oversight

## Smart Model Routing

**FIRST ACTION:** Before delegating any work, read the agent reference file:
```
Read file: docs/shared/agent-tiers.md
```
This provides the complete agent tier matrix, MCP tool assignments, and selection guidance.

**CRITICAL: Always pass `model` parameter explicitly!**

```
Task(subagent_type="oh-my-claudecode:architect-low", model="haiku", prompt="...")
Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")
Task(subagent_type="oh-my-claudecode:architect", model="opus", prompt="...")
```

## Background Execution Rules

**Run in Background** (set `run_in_background: true`):
- Package installation: npm install, pip install, cargo build
- Build processes: npm run build, make, tsc
- Test suites: npm test, pytest, cargo test

**Run Blocking** (foreground):
- Quick status checks: git status, ls, pwd
- File reads, edits
- Simple commands

## Relationship to Other Modes

```
ralph (persistence wrapper)
└── includes: ultrawork (this skill)
    └── provides: parallel execution only

autopilot (autonomous execution)
└── includes: ralph
    └── includes: ultrawork (this skill)

ecomode (token efficiency)
└── modifies: ultrawork's model selection
```

## When to Use Ultrawork Directly

Use ultrawork directly when you want:
- Parallel execution without persistence guarantees
- Manual oversight over completion
- Quick parallel tasks where you'll verify yourself

Use `ralph` instead when you want:
- Verified completion (architect check)
- Automatic retry on failure
- Session persistence for resume

## Completion Verification (Direct Invocations)

When ultrawork is invoked directly (not via ralph), apply lightweight verification before claiming completion:

### Quick Verification Checklist
- [ ] **BUILD:** `tsc --noEmit` or equivalent passes
- [ ] **TESTS:** Run affected tests, all pass
- [ ] **ERRORS:** No new errors introduced

This is lighter than ralph's full verification but ensures basic quality for direct ultrawork usage.

For full persistence and comprehensive verification, use `ralph` mode instead.
