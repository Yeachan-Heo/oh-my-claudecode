---
description: Alias for /plan --consensus
aliases: [rp, planloop]
---

# ralplan

**Alias for:** `/plan --consensus`

Iterative planning with Planner, Architect, and Critic until consensus is reached.

## Usage

```bash
/ralplan [task description]
```

This is equivalent to:

```bash
/plan --consensus [task description]
```

## Description

The ralplan workflow:
1. Planner creates initial plan
2. Architect reviews for technical feasibility
3. Critic evaluates for completeness and quality
4. Iterate until all three agents reach consensus

## See Also

- `/plan` - Strategic planning with optional interview workflow
- `/review` - Review a plan with Critic
