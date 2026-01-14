---
name: chillwork
description: Cost-optimized mode - prefer cheaper model tiers (-low variants) while maintaining full parallelization
---

# Chillwork Skill

Activates cost-optimized mode by defaulting to LOW tier agents instead of MEDIUM.

## When Activated

This skill modifies Claude's model routing to minimize token costs:

1. **Model Downgrading**: Default to `-low` agent variants instead of standard ones
2. **Full Parallelization**: Same as default - parallelize when profitable
3. **Normal Delegation**: Same as default - delegate specialized work to agents
4. **Background Execution**: Same as default - use for long operations
5. **Persistent Completion**: Continue until all tasks are verified complete

## Chillwork Model Routing (CRITICAL)

**DEFAULT to LOW tier agents. Same parallelization, cheaper models.**

### The Key Difference

| Mode | Default Tier | Parallelization | Delegation |
|------|-------------|-----------------|------------|
| Default | MEDIUM | Yes (up to 5) | Yes |
| Ultrawork | MEDIUM | Yes (unlimited) | Aggressive |
| **Chillwork** | **LOW** | Yes (up to 5) | Yes |

### Routing Bias

| Normal Route | Chillwork Override | When to Override Back |
|--------------|-------------------|----------------------|
| HIGH (Opus) | **MEDIUM (Sonnet)** | Security, complex debugging |
| MEDIUM (Sonnet) | **LOW (Haiku)** | Multi-file changes, complex logic |
| LOW (Haiku) | **LOW (Haiku)** | Already cheapest |

### Agent Selection (Prefer -low variants)

| Domain | Chillwork Default | Escalate To | Use Opus Only For |
|--------|-------------------|-------------|-------------------|
| **Analysis** | `oracle-low` | `oracle-medium` | Security, architecture |
| **Execution** | `sisyphus-junior-low` | `sisyphus-junior` | Complex multi-file |
| **Search** | `explore` | `explore-medium` | Deep analysis |
| **Research** | `librarian-low` | `librarian` | Comprehensive research |
| **Frontend** | `frontend-engineer-low` | `frontend-engineer` | Design systems |
| **Docs** | `document-writer` | - | - |
| **Planning** | - | - | `prometheus`, `momus` |

### Routing Examples

```
// In chillwork mode, prefer -low variants:

// Question about code → oracle-low (not oracle-medium)
Task(subagent_type="oracle-low", prompt="What does this function return?")

// Feature implementation → sisyphus-junior-low (not sisyphus-junior)
Task(subagent_type="sisyphus-junior-low", prompt="Add error handling to login")

// Multiple independent tasks → STILL PARALLELIZE with -low agents
Task(subagent_type="sisyphus-junior-low", prompt="Add validation to form A")
Task(subagent_type="sisyphus-junior-low", prompt="Add validation to form B")
// ^^^ Launch these in parallel, same as default mode

// Complex multi-file refactor → escalate to standard tier
Task(subagent_type="sisyphus-junior", prompt="Refactor auth module across 5 files")
```

## Parallelization (Same as Default)

**Parallelize when profitable - just use cheaper agents**

- 2+ independent tasks with >30 seconds work each → Parallelize with `-low` agents
- Sequential dependencies → Run in order
- Quick tasks (<10 seconds) → Do directly

## Background Execution (Same as Default)

**Run in Background** (set `run_in_background: true`):
- Package installation: npm install, pip install, cargo build
- Build processes: npm run build, make, tsc
- Test suites: npm test, pytest, cargo test

**Run Blocking** (foreground):
- Quick status checks
- File reads, edits
- Simple commands

## When to Use Chillwork

- Routine development work
- Simple feature additions
- Bug fixes in well-understood code
- Documentation tasks
- Exploratory work / prototyping
- Cost-sensitive environments

## When NOT to Use Chillwork

- Security-critical code (use default)
- Complex debugging sessions (need oracle)
- Architectural decisions (need opus-level reasoning)
- Time-sensitive work (use ultrawork)

## Escalation Rules

Upgrade to higher tier ONLY when:
1. LOW tier agent produces incorrect or incomplete results
2. Task involves security-sensitive code
3. Task requires cross-cutting architectural changes
4. User explicitly requests higher quality

## Verification Checklist

Before stopping, verify:
- [ ] TODO LIST: Zero pending/in_progress tasks
- [ ] FUNCTIONALITY: All requested features work
- [ ] TESTS: All tests pass (if applicable)
- [ ] ERRORS: Zero unaddressed errors

**If ANY checkbox is unchecked, CONTINUE WORKING.**

The boulder reaches the summit efficiently - same speed, lower cost.
