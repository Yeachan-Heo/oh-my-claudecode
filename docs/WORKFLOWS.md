# Practical Workflows

> Real-world scenarios showing how to combine OMC skills for common development tasks.

This guide assumes you have completed [Getting Started](./GETTING-STARTED.md) and have OMC installed. Each scenario starts with a goal and walks through the skills in order.

---

## Scenario 1: Implement a GitHub Issue

**Goal:** Take a GitHub issue and deliver a tested, reviewed PR.

### Step 1 — Clarify requirements

```
deep interview "implement issue #42"
```

The `deep-interview` skill runs a Socratic dialogue: it asks probing questions about edge cases, constraints, and acceptance criteria until ambiguity drops below a threshold. You get a crystallized requirements document.

### Step 2 — Plan the implementation

```
ralplan "implement user avatar upload per requirements above"
```

`ralplan` triggers a Planner → Architect → Critic consensus loop. The output is a step-by-step implementation plan with files to modify, test strategy, and risk assessment.

### Step 3 — Execute the plan

On approval, `ralplan` offers two execution paths:

- **`team`** (recommended for multi-file changes) — launches N parallel agents working from a shared task list
- **`ralph`** (for sequential work) — single agent that loops: implement → verify → fix until done

### Step 4 — Review before merging

```
/oh-my-claudecode:requesting-code-review
```

This triggers the `code-reviewer` agent (opus) to inspect your changes against the original requirements. Fix any findings, then create your PR.

### Summary

```
deep-interview → ralplan → team or ralph → code-review
```

---

## Scenario 2: Refactor a Module

**Goal:** Restructure a module without breaking existing functionality.

### Step 1 — Explore the codebase

```
deepsearch "authentication module dependencies"
```

The `deepsearch` keyword triggers a thorough codebase exploration using the `explore` agent. You get a map of files, dependencies, and call chains.

### Step 2 — Plan with safety checks

```
ralplan "refactor auth module: extract token refresh into separate service"
```

The plan will include a test strategy. If the Critic flags missing test coverage, the plan is revised before execution.

### Step 3 — Execute with parallel agents

```
ultrawork
```

`ultrawork` splits independent subtasks across parallel agents. Each agent works on its own file/function without blocking others. Good for refactors where changes are isolated.

### Step 4 — Verify nothing broke

```
/oh-my-claudecode:ultraqa
```

`ultraqa` runs a QA cycle: execute tests → verify results → fix failures → repeat until all tests pass.

### Summary

```
deepsearch → ralplan → ultrawork → ultraqa
```

---

## Scenario 3: Debug a Production Bug

**Goal:** Find the root cause of a bug and fix it with confidence.

### Step 1 — Trace the root cause

```
trace "TypeError: Cannot read property 'id' of undefined in OrderService.processPayment"
```

The `trace` skill launches competing tracer agents, each pursuing a different hypothesis. Evidence is gathered and ranked. You get a prioritized list of likely root causes.

### Step 2 — Analyze deeper if needed

```
deep-analyze
```

If `trace` narrows it down but you need more context, `deep-analyze` (the analysis mode keyword) triggers structured reasoning about the problem.

### Step 3 — Fix with TDD

```
tdd "fix null reference in OrderService.processPayment"
```

The `tdd` keyword triggers Test-Driven Development mode: write a failing test first, then implement the fix, then verify the test passes.

### Step 4 — Verify the fix

```
/oh-my-claudecode:verify
```

The `verifier` agent checks that the fix addresses the original error, tests pass, and no regressions were introduced.

### Summary

```
trace → deep-analyze (optional) → tdd → verify
```

---

## Scenario 4: Review a Pull Request

**Goal:** Thoroughly review someone else's PR with structured feedback.

### Step 1 — Set up a review session

```
/oh-my-claudecode:project-session-manager
```

`project-session-manager` (PSM) creates an isolated worktree for the PR branch. This keeps your main workspace clean.

### Step 2 — Run the review

```
/oh-my-claudecode:code-review
```

The `code-reviewer` agent (opus) examines the diff for:
- Correctness and edge cases
- Security vulnerabilities
- Performance implications
- Code style and maintainability

### Step 3 — Check for AI slop (optional)

```
deslop
```

If the PR was AI-generated, `ai-slop-cleaner` detects and flags common AI code patterns: unnecessary abstractions, over-commenting, defensive code that handles impossible cases.

### Summary

```
project-session-manager → code-review → deslop (optional)
```

---

## Quick Reference: Which Skill for What?

| I want to... | Use this |
|---|---|
| Run something end-to-end automatically | `autopilot` |
| Plan before executing | `ralplan` |
| Execute with parallel agents | `ultrawork` or `team` |
| Execute sequentially with verification | `ralph` |
| Debug a bug | `trace` → `tdd` |
| Review code | `code-review` |
| Run tests until they pass | `ultraqa` |
| Clean up AI-generated code | `deslop` |
| Explore the codebase | `deepsearch` |
| Get external documentation | `external-context` |
| Use Claude + Codex + Gemini together | `ccg` |
| Cancel any running mode | `cancelomc` |

---

## Next Steps

- See each skill's built-in documentation: `/oh-my-claudecode:<skill-name>` with no arguments
- Browse the [Agent Catalog](./AGENTS.md) for available agents
- Check [Architecture](./ARCHITECTURE.md) for how OMC orchestrates agents
