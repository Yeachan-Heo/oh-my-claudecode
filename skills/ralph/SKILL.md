---
name: ralph
description: Self-referential loop until task completion with architect verification
---

[RALPH + ULTRAWORK - ITERATION {{ITERATION}}/{{MAX}}]

Your previous attempt did not output the completion promise. Continue working on the task.

<Purpose>
Ralph is a persistence loop that keeps working on a task until it is fully complete and architect-verified. It wraps ultrawork's parallel execution with session persistence, automatic retry on failure, and mandatory verification before completion.
</Purpose>

<Use_When>
- Task requires guaranteed completion with verification (not just "do your best")
- User says "ralph", "don't stop", "must complete", "finish this", or "keep going until done"
- Work may span multiple iterations and needs persistence across retries
- Task benefits from parallel execution with architect sign-off at the end
</Use_When>

<Do_Not_Use_When>
- User wants a full autonomous pipeline from idea to code -- use `autopilot` instead
- User wants to explore or plan before committing -- use `plan` skill instead
- User wants a quick one-shot fix -- delegate directly to an executor agent
- User wants manual control over completion -- use `ultrawork` directly
</Do_Not_Use_When>

<Why_This_Exists>
Complex tasks often fail silently: partial implementations get declared "done", tests get skipped, edge cases get forgotten. Ralph prevents this by looping until work is genuinely complete, requiring fresh verification evidence before allowing completion, and using tiered architect review to confirm quality.
</Why_This_Exists>

<Execution_Policy>
- Fire independent agent calls simultaneously -- never wait sequentially for independent work
- Use `run_in_background: true` for long operations (installs, builds, test suites)
- Always pass the `model` parameter explicitly when delegating to agents
- Read `docs/shared/agent-tiers.md` before first delegation to select correct agent tiers
- Deliver the full implementation: no scope reduction, no partial completion, no deleting tests to make them pass
</Execution_Policy>

<Steps>
1. **Review progress**: Check TODO list and any prior iteration state
2. **Continue from where you left off**: Pick up incomplete tasks
3. **Delegate in parallel**: Route tasks to specialist agents at appropriate tiers
   - Simple lookups: LOW tier (Haiku) -- "What does this function return?"
   - Standard work: MEDIUM tier (Sonnet) -- "Add error handling to this module"
   - Complex analysis: HIGH tier (Opus) -- "Debug this race condition"
4. **Run long operations in background**: Builds, installs, test suites use `run_in_background: true`
5. **Verify completion with fresh evidence**:
   a. Identify what command proves the task is complete
   b. Run verification (test, build, lint)
   c. Read the output -- confirm it actually passed
   d. Check: zero pending/in_progress TODO items
6. **Architect verification** (tiered):
   - <5 files, <100 lines with full tests: STANDARD tier minimum (architect-medium / Sonnet)
   - Standard changes: STANDARD tier (architect-medium / Sonnet)
   - >20 files or security/architectural changes: THOROUGH tier (architect / Opus)
   - Ralph floor: always at least STANDARD, even for small changes
7. **On approval**: Run `/oh-my-claudecode:cancel` to cleanly exit and clean up all state files
8. **On rejection**: Fix the issues raised, then re-verify at the same tier
</Steps>

<Tool_Usage>
- Before first MCP tool use, call `ToolSearch("mcp")` to discover deferred MCP tools
- Use `ask_codex` with `agent_role: "architect"` for verification cross-checks when changes are security-sensitive, architectural, or involve complex multi-system integration
- Skip Codex consultation for simple feature additions, well-tested changes, or time-critical verification
- If ToolSearch finds no MCP tools or Codex is unavailable, proceed with architect agent verification alone -- never block on external tools
- Use `state_write` / `state_read` for ralph mode state persistence between iterations
</Tool_Usage>

<Examples>
<Good>
Correct parallel delegation:
```
Task(subagent_type="oh-my-claudecode:executor-low", model="haiku", prompt="Add type export for UserConfig")
Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="Implement the caching layer for API responses")
Task(subagent_type="oh-my-claudecode:executor-high", model="opus", prompt="Refactor auth module to support OAuth2 flow")
```
Why good: Three independent tasks fired simultaneously at appropriate tiers.
</Good>

<Good>
Correct verification before completion:
```
1. Run: npm test           → Output: "42 passed, 0 failed"
2. Run: npm run build      → Output: "Build succeeded"
3. Run: lsp_diagnostics    → Output: 0 errors
4. Spawn architect-medium  → Verdict: "APPROVED"
5. Run /oh-my-claudecode:cancel
```
Why good: Fresh evidence at each step, architect verification, then clean exit.
</Good>

<Bad>
Claiming completion without verification:
"All the changes look good, the implementation should work correctly. Task complete."
Why bad: Uses "should" and "look good" -- no fresh test/build output, no architect verification.
</Bad>

<Bad>
Sequential execution of independent tasks:
```
Task(executor-low, "Add type export") → wait →
Task(executor, "Implement caching") → wait →
Task(executor-high, "Refactor auth")
```
Why bad: These are independent tasks that should run in parallel, not sequentially.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- Stop and report when a fundamental blocker requires user input (missing credentials, unclear requirements, external service down)
- Stop when the user says "stop", "cancel", or "abort" -- run `/oh-my-claudecode:cancel`
- Continue working when the hook system sends "The boulder never stops" -- this means the iteration continues
- If architect rejects verification, fix the issues and re-verify (do not stop)
- If the same issue recurs across 3+ iterations, report it as a potential fundamental problem
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] All requirements from the original task are met (no scope reduction)
- [ ] Zero pending or in_progress TODO items
- [ ] Fresh test run output shows all tests pass
- [ ] Fresh build output shows success
- [ ] lsp_diagnostics shows 0 errors on affected files
- [ ] Architect verification passed (STANDARD tier minimum)
- [ ] `/oh-my-claudecode:cancel` run for clean state cleanup
</Final_Checklist>

<Advanced>
## PRD Mode (Optional)

When the user provides the `--prd` flag, initialize a Product Requirements Document before starting the ralph loop.

### Detecting PRD Mode
Check if `{{PROMPT}}` contains `--prd` or `--PRD`.

### PRD Workflow
1. Create `.omc/prd.json` and `.omc/progress.txt`
2. Parse the task (everything after `--prd` flag)
3. Break down into user stories:

```json
{
  "project": "[Project Name]",
  "branchName": "ralph/[feature-name]",
  "description": "[Feature description]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Short title]",
      "description": "As a [user], I want to [action] so that [benefit].",
      "acceptanceCriteria": ["Criterion 1", "Typecheck passes"],
      "priority": 1,
      "passes": false
    }
  ]
}
```

4. Create `progress.txt` with timestamp and empty patterns section
5. Guidelines: right-sized stories (one session each), verifiable criteria, independent stories, priority order (foundational work first)
6. Proceed to normal ralph loop using user stories as the task list

### Example
User input: `--prd build a todo app with React and TypeScript`
Workflow: Detect flag, extract task, create `.omc/prd.json`, create `.omc/progress.txt`, begin ralph loop.

## Background Execution Rules

**Run in background** (`run_in_background: true`):
- Package installation (npm install, pip install, cargo build)
- Build processes (make, project build commands)
- Test suites
- Docker operations (docker build, docker pull)

**Run blocking** (foreground):
- Quick status checks (git status, ls, pwd)
- File reads and edits
- Simple commands
</Advanced>

Original task:
{{PROMPT}}
