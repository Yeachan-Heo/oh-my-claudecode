---
description: Token-efficient parallel execution mode using Haiku and Sonnet agents
aliases: [eco, efficient, save-tokens, budget]
---

# Ecomode Skill

Activates token-efficient parallel execution for pro-plan users who prioritize cost efficiency over maximum capability.

## When to Use Ecomode

- You're on a pro plan and want to conserve tokens
- Tasks don't require complex reasoning (no deep debugging, architecture design)
- You want faster responses (smaller models = lower latency)
- Standard development work: features, bug fixes, refactoring

## How It Differs from Ultrawork

| Aspect | Ecomode | Ultrawork |
|--------|---------|-----------|
| **Default Tier** | Haiku (LOW) | Sonnet (MEDIUM) |
| **Fallback Tier** | Sonnet (MEDIUM) | Opus (HIGH) |
| **Opus Usage** | Avoided (planning only if essential) | Used for complex tasks |
| **Token Cost** | Lower | Higher |
| **Best For** | Standard dev work | Complex challenges |

## Activation

**Explicit keywords** (always activates ecomode):
- "ecomode", "eco", "efficient", "save-tokens", "budget"

**Examples:**
```
eco fix the login bug
ecomode: refactor the API
budget mode: add form validation
```

## Agent Routing

Ecomode routes tasks to lower-tier agents:

| Domain | Ecomode Uses | Ultrawork Uses |
|--------|--------------|----------------|
| Analysis | architect-low (haiku) | architect (opus) |
| Execution | executor-low (haiku) | executor-high (opus) |
| Frontend | designer-low (haiku) | designer-high (opus) |
| Search | explore (haiku) | explore (sonnet) |

## Setting as Default

Run `/oh-my-claudecode:omc-setup` to set ecomode as your default parallel execution mode.

When set as default, saying "fast" or "parallel" will activate ecomode instead of ultrawork.

## Disabling Ecomode

To completely disable ecomode (prevents all ecomode keyword detection and activation), add to `~/.claude/.omc-config.json`:

```json
{
  "ecomode": {
    "enabled": false
  }
}
```

When disabled, ecomode keywords ("eco", "ecomode", "efficient", "save-tokens", "budget") will be ignored and will not trigger ecomode activation.

## Cancellation

- `/oh-my-claudecode:cancel` - Cancel active mode
- Say "stop" or "cancel" - Unified cancellation
