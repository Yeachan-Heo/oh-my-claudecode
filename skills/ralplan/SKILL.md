---
name: ralplan
description: Alias for /plan --consensus
---

# Ralplan (Consensus Planning Alias)

Ralplan is a shorthand alias for `/oh-my-claudecode:plan --consensus`. It triggers iterative planning with Planner, Architect, and Critic agents until consensus is reached.

## Usage

```
/oh-my-claudecode:ralplan "task description"
```

## Behavior

This skill invokes the Plan skill in consensus mode:

```
/oh-my-claudecode:plan --consensus <arguments>
```

The consensus workflow:
1. **Planner** creates initial plan
2. **User feedback**: **MUST** use `AskUserQuestion` to present the draft plan before review (Proceed to review / Request changes / Skip review)
3. **Architect** reviews for architectural soundness — **await completion before step 4**
4. **Critic** evaluates against quality criteria — run only after step 3 completes
5. If Critic rejects: iterate with feedback (max 5 iterations)
6. On Critic approval: **MUST** use `AskUserQuestion` to present the plan with approval options
7. User chooses: Approve, Request changes, or Reject
8. On approval: **MUST** invoke `Skill("oh-my-claudecode:ralph")` for execution -- never implement directly

> **Important:** Steps 3 and 4 MUST run sequentially. Do NOT issue both `ask_codex` calls in the same parallel batch — if one hits a 429 rate-limit error, Claude Code will cancel the sibling call ("Sibling tool call errored"), causing the entire review to fail. On a rate-limit error, retry once after 5–10 s; on second failure fall back to the equivalent Claude agent.

Follow the Plan skill's full documentation for consensus mode details.
