---
name: ecomode
description: Token-efficient model routing modifier
---

# Ecomode Skill

Token-efficient model routing. This is a **MODIFIER**, not a standalone execution mode.

## What Ecomode Does

Overrides default model selection to prefer cheaper tiers:

| Default Tier | Ecomode Override |
|--------------|------------------|
| HIGH (opus) | MEDIUM (sonnet), HIGH only if essential |
| MEDIUM (sonnet) | LOW (haiku) first, MEDIUM if fails |
| LOW (haiku) | LOW (haiku) - no change |

## What Ecomode Does NOT Do

- **Persistence**: Use `ralph` for "don't stop until done"
- **Parallel Execution**: Use `ultrawork` for parallel agents
- **Delegation Enforcement**: Always active via core orchestration

## Combining Ecomode with Other Modes

Ecomode is a modifier that combines with execution modes:

| Combination | Effect |
|-------------|--------|
| `eco ralph` | Ralph loop with cheaper agents |
| `eco ultrawork` | Parallel execution with cheaper agents |
| `eco autopilot` | Full autonomous with cost optimization |

## Ecomode Routing Rules

**ALWAYS prefer lower tiers. Only escalate when task genuinely requires it.**

| Decision | Rule |
|----------|------|
| DEFAULT | Use LOW tier (Haiku) for all tasks |
| UPGRADE | Use MEDIUM (Sonnet) only when task complexity warrants |
| AVOID | HIGH tier (Opus) - only for planning/critique if essential |

## Agent Selection in Ecomode

**FIRST ACTION:** Before delegating any work, read the agent reference file:
```
Read file: docs/shared/agent-tiers.md
```
This provides the complete agent tier matrix, MCP tool assignments, and selection guidance.

**Ecomode preference order:**

```
// PREFERRED - Use for most tasks
Task(subagent_type="oh-my-claudecode:executor-low", model="haiku", prompt="...")
Task(subagent_type="oh-my-claudecode:explore", model="haiku", prompt="...")
Task(subagent_type="oh-my-claudecode:architect-low", model="haiku", prompt="...")

// FALLBACK - Only if LOW fails
Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")
Task(subagent_type="oh-my-claudecode:architect-medium", model="sonnet", prompt="...")

// AVOID - Only for planning/critique if essential
Task(subagent_type="oh-my-claudecode:planner", model="opus", prompt="...")
```

## Delegation Enforcement

Ecomode maintains all delegation rules from core protocol with cost-optimized routing:

| Action | Delegate To | Model |
|--------|-------------|-------|
| Code changes | executor-low / executor | haiku / sonnet |
| Analysis | architect-low | haiku |
| Search | explore | haiku |
| Documentation | writer | haiku |

### Background Execution
Long-running commands (install, build, test) run in background. Maximum 5 concurrent.

## Token Savings Tips

1. **Batch similar tasks** to one agent instead of spawning many
2. **Use explore (haiku)** for file discovery, not architect
3. **Prefer executor-low** for simple changes - only upgrade if it fails
4. **Use writer (haiku)** for all documentation tasks
5. **Avoid opus agents** unless the task genuinely requires deep reasoning

## State Management

Ecomode state is tracked in `.omc/state/ecomode-state.json`.

When work is complete, run `/oh-my-claudecode:cancel` for clean state cleanup.
