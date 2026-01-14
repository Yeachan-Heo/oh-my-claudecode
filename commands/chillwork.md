---
description: Cost-optimized mode - prefer cheaper model tiers (-low variants) while maintaining full parallelization
---

[CHILLWORK MODE ACTIVATED - COST OPTIMIZATION]

$ARGUMENTS

## THE CHILLWORK PRINCIPLE

You are now operating in **COST-OPTIMIZED** mode. Use `-low` agent variants by default. Same parallelization, cheaper models.

**Chillwork = Default behavior + LOW tier preference**

## CHILLWORK VS OTHER MODES

| Behavior | Default | Ultrawork | Chillwork |
|----------|---------|-----------|-----------|
| Default tier | MEDIUM | MEDIUM | **LOW** |
| Parallelization | Up to 5 | Unlimited | Up to 5 |
| Delegation | Normal | Aggressive | Normal |
| Background ops | Long ops | Everything | Long ops |

## MODEL ROUTING OVERRIDE

**Always prefer `-low` agent variants:**

| Task Type | Default Agent | Chillwork Agent |
|-----------|---------------|-----------------|
| Code questions | `oracle-medium` | **`oracle-low`** |
| Implementation | `sisyphus-junior` | **`sisyphus-junior-low`** |
| File searches | `explore` | **`explore`** (already low) |
| Research | `librarian` | **`librarian-low`** |
| Frontend work | `frontend-engineer` | **`frontend-engineer-low`** |
| Documentation | `document-writer` | **`document-writer`** (already low) |

## EXECUTION PROTOCOL

### 1. DELEGATE WITH -LOW AGENTS
Route to specialized agents as normal, but use `-low` variants:

```
// Good - uses -low variant
Task(subagent_type="sisyphus-junior-low", prompt="Add validation")

// Avoid in chillwork - uses default tier
Task(subagent_type="sisyphus-junior", prompt="Add validation")
```

### 2. PARALLELIZE NORMALLY
Launch multiple `-low` agents in parallel when tasks are independent:

```
// Multiple independent tasks? STILL PARALLELIZE
Task(subagent_type="sisyphus-junior-low", prompt="Task A")
Task(subagent_type="sisyphus-junior-low", prompt="Task B")
Task(subagent_type="sisyphus-junior-low", prompt="Task C")
// ^^^ All in parallel, same as default mode
```

### 3. ESCALATE WHEN NEEDED
Upgrade to standard/high tier only when:
- LOW tier produces incorrect results
- Security-sensitive code
- Complex architectural decisions
- User requests higher quality

## THE CHILLWORK PROMISE

Before stopping, VERIFY:
- [ ] Todo list: ZERO pending/in_progress tasks
- [ ] All functionality: TESTED and WORKING
- [ ] All errors: RESOLVED
- [ ] User's request: FULLY SATISFIED

**If ANY checkbox is unchecked, CONTINUE WORKING. No exceptions.**

## THE EFFICIENT BOULDER

Same parallelization. Same delegation. Cheaper models. The boulder reaches the summit at lower cost.
