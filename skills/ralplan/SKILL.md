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

## Flags

- `--interactive`: Enables user prompts at key decision points (draft review in step 2 and final approval in step 6). Without this flag the workflow runs fully automated — Planner → Architect → Critic loop — and outputs the final plan without asking for confirmation.

## Usage with interactive mode

```
/oh-my-claudecode:ralplan --interactive "task description"
```

## Behavior

This skill invokes the Plan skill in consensus mode:

```
/oh-my-claudecode:plan --consensus <arguments>
```

The consensus workflow:
1. **Planner** creates initial plan
2. **User feedback** *(--interactive only)*: If `--interactive` is set, use `AskUserQuestion` to present the draft plan before review (Proceed to review / Request changes / Skip review). Otherwise, automatically proceed to review.
3. **Architect** reviews for architectural soundness — **await completion before step 4**
4. **Critic** evaluates against quality criteria — run only after step 3 completes
5. If Critic rejects: iterate with feedback (max 5 iterations)
6. On Critic approval *(--interactive only)*: If `--interactive` is set, use `AskUserQuestion` to present the plan with approval options (Approve and execute via ralph / Approve and implement via team / Clear context and implement / Request changes / Reject). Otherwise, output the final plan and stop.
7. *(--interactive only)* User chooses: Approve (ralph or team), Request changes, or Reject
8. *(--interactive only)* On approval: invoke `Skill("oh-my-claudecode:ralph")` for sequential execution or `Skill("oh-my-claudecode:team")` for parallel team execution -- never implement directly

> **Important:** Steps 3 and 4 MUST run sequentially. Do NOT issue both agent Task calls in the same parallel batch. Always await the Architect result before issuing the Critic Task.

Follow the Plan skill's full documentation for consensus mode details.

## Pre-Execution Gate

### Why the Gate Exists

Execution modes (ralph, autopilot, team, ultrawork, ultrapilot) spin up heavy multi-agent orchestration. When launched on a vague request like "ralph improve the app", agents have no clear target — they waste cycles on scope discovery that should happen during planning, often delivering partial or misaligned work that requires rework.

The ralplan-first gate intercepts underspecified execution requests and redirects them through the ralplan consensus planning workflow. This ensures:
- **Explicit scope**: A PRD defines exactly what will be built
- **Test specification**: Acceptance criteria are testable before code is written
- **Consensus**: Planner, Architect, and Critic agree on the approach
- **No wasted execution**: Agents start with a clear, bounded task

### Good vs Bad Prompts

**Passes the gate** (specific enough for direct execution):
- `ralph fix the null check in src/hooks/bridge.ts:326`
- `autopilot implement issue #42`
- `team add validation to function processKeywordDetector`
- `ralph do:\n1. Add input validation\n2. Write tests\n3. Update README`
- `ultrawork add the user model in src/models/user.ts`

**Gated — redirected to ralplan** (needs scoping first):
- `ralph fix this`
- `autopilot build the app`
- `team improve performance`
- `ralph add authentication`
- `ultrawork make it better`

**Bypass the gate** (when you know what you want):
- `force: ralph refactor the auth module`
- `! autopilot optimize everything`

### End-to-End Flow Example

1. User types: `ralph add user authentication`
2. Gate detects: execution keyword (`ralph`) + underspecified prompt (no files, functions, or test spec)
3. Gate redirects to **ralplan** with message explaining the redirect
4. Ralplan consensus runs:
   - **Planner** creates initial plan (which files, what auth method, what tests)
   - **Architect** reviews for soundness
   - **Critic** validates quality and testability
5. On consensus approval, user chooses execution path:
   - **ralph**: sequential execution with verification
   - **team**: parallel coordinated agents
6. Execution begins with a clear, bounded plan

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Gate fires on a well-specified prompt | Add a file reference, function name, or issue number to anchor the request |
| Want to bypass the gate | Prefix with `force:` or `!` (e.g., `force: ralph fix it`) |
| Gate does not fire on a vague prompt | The gate only catches prompts with <=15 effective words and no concrete anchors; add more detail or use `/ralplan` explicitly |
| Redirected to ralplan but want to skip planning | In the ralplan workflow, say "just do it" or "skip planning" to transition directly to execution |
