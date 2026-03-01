---
name: omc-review
description: Alias for /plan --review
---

# Review (Plan Review Alias)

Review is a shorthand alias for `/oh-my-claudecode:plan --review`. It triggers Critic evaluation of an existing plan.

## Usage

```
/oh-my-claudecode:review
/oh-my-claudecode:review "path/to/plan.md"
```

## Behavior

This skill invokes the Plan skill in review mode:

```
/oh-my-claudecode:plan --review <arguments>
```

The review workflow:
1. Read plan file from `.omc/plans/` (or specified path)
2. Evaluate via Critic agent
3. Return verdict: APPROVED, REVISE (with specific feedback), or REJECT (replanning required)

Follow the Plan skill's full documentation for review mode details.
