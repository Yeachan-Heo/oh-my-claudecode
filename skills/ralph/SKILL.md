---
name: ralph
description: Self-referential loop until task completion with architect verification
---

[RALPH + ULTRAWORK - ITERATION {{ITERATION}}/{{MAX}}]

Your previous attempt did not output the completion promise. Continue working on the task.

<Purpose>
Ralph is a PRD-driven persistence loop that keeps working on a task until ALL user stories in prd.json have passes: true and are architect-verified. It wraps ultrawork's parallel execution with session persistence, automatic retry on failure, structured story tracking, and mandatory verification before completion.
</Purpose>

<Use_When>
- Task requires guaranteed completion with verification (not just "do your best")
- User says "ralph", "don't stop", "must complete", "finish this", or "keep going until done"
- Work may span multiple iterations and needs persistence across retries
- Task benefits from structured PRD-driven execution with architect sign-off
</Use_When>

<Do_Not_Use_When>
- User wants a full autonomous pipeline from idea to code -- use `autopilot` instead
- User wants to explore or plan before committing -- use `plan` skill instead
- User wants a quick one-shot fix -- delegate directly to an executor agent
- User wants manual control over completion -- use `ultrawork` directly
</Do_Not_Use_When>

<Why_This_Exists>
Complex tasks often fail silently: partial implementations get declared "done", tests get skipped, edge cases get forgotten. Ralph prevents this by:
1. Structuring work into discrete user stories with testable acceptance criteria (prd.json)
2. Iterating story-by-story until each one passes
3. Tracking progress and learnings across iterations (progress.txt)
4. Requiring fresh architect verification against specific acceptance criteria before completion
</Why_This_Exists>

<PRD_Mode>
By default, ralph operates in PRD mode. A scaffold `prd.json` is auto-generated when ralph starts if none exists.

**Opt-out:** If `{{PROMPT}}` contains `--no-prd`, skip PRD generation and work in legacy mode (no story tracking, generic verification). Use this for trivial quick fixes.
</PRD_Mode>

<Execution_Policy>
- Fire independent agent calls simultaneously -- never wait sequentially for independent work
- Use `run_in_background: true` for long operations (installs, builds, test suites)
- Always pass the `model` parameter explicitly when delegating to agents
- Read `docs/shared/agent-tiers.md` before first delegation to select correct agent tiers
- Deliver the full implementation: no scope reduction, no partial completion, no deleting tests to make them pass
</Execution_Policy>

<Steps>
1. **PRD Setup** (first iteration only):
   a. Check if `prd.json` exists (in project root or `.omc/`). If it already exists, read it and proceed to Step 2.
   b. If no `prd.json` exists, the system has auto-generated a scaffold. Read `.omc/prd.json`.
   c. **CRITICAL: Refine the scaffold.** The auto-generated PRD has generic acceptance criteria ("Implementation is complete", etc.). You MUST replace these with task-specific criteria:
      - Analyze the original task and break it into right-sized user stories (each completable in one iteration)
      - Write concrete, verifiable acceptance criteria for each story (e.g., "Function X returns Y when given Z", "Test file exists at path P and passes")
      - If acceptance criteria are generic (e.g., "Implementation is complete"), REPLACE them with task-specific criteria before proceeding
      - Order stories by priority (foundational work first, dependent work later)
      - Write the refined `prd.json` back to disk
   d. Initialize `progress.txt` if it doesn't exist

2. **Pick next story**: Read `prd.json` and select the highest-priority story with `passes: false`. This is your current focus.

3. **Implement the current story**:
   - Delegate to specialist agents at appropriate tiers:
     - Simple lookups: LOW tier (Haiku) -- "What does this function return?"
     - Standard work: MEDIUM tier (Sonnet) -- "Add error handling to this module"
     - Complex analysis: HIGH tier (Opus) -- "Debug this race condition"
   - If during implementation you discover sub-tasks, add them as new stories to `prd.json`
   - Run long operations in background: Builds, installs, test suites use `run_in_background: true`

4. **Verify the current story's acceptance criteria**:
   a. For EACH acceptance criterion in the story, verify it is met with fresh evidence
   b. Run relevant checks (test, build, lint, typecheck) and read the output
   c. If any criterion is NOT met, continue working -- do NOT mark the story as complete

5. **Mark story complete**:
   a. When ALL acceptance criteria are verified, set `passes: true` for this story in `prd.json`
   b. Record progress in `progress.txt`: what was implemented, files changed, learnings for future iterations
   c. Add any discovered codebase patterns to `progress.txt`

6. **Check PRD completion**:
   a. Read `prd.json` -- are ALL stories marked `passes: true`?
   b. If NOT all complete, loop back to Step 2 (pick next story)
   c. If ALL complete, proceed to Step 7 (architect verification)

7. **Architect verification** (tiered, against acceptance criteria):
   - <5 files, <100 lines with full tests: STANDARD tier minimum (architect-medium / Sonnet)
   - Standard changes: STANDARD tier (architect-medium / Sonnet)
   - >20 files or security/architectural changes: THOROUGH tier (architect / Opus)
   - Ralph floor: always at least STANDARD, even for small changes
   - The architect verifies against the SPECIFIC acceptance criteria from prd.json, not vague "is it done?"

8. **On approval**: Run `/oh-my-claudecode:cancel` to cleanly exit and clean up all state files

9. **On rejection**: Fix the issues raised, re-verify at the same tier, then loop back to check if the story needs to be marked incomplete
</Steps>

<Tool_Usage>
- Use `Task(subagent_type="oh-my-claudecode:architect", ...)` for verification cross-checks when changes are security-sensitive, architectural, or involve complex multi-system integration
- Skip architect consultation for simple feature additions, well-tested changes, or time-critical verification
- Proceed with architect agent verification alone -- never block on unavailable tools
- Use `state_write` / `state_read` for ralph mode state persistence between iterations
</Tool_Usage>

<Examples>
<Good>
PRD refinement in Step 1:
```
Auto-generated scaffold has:
  acceptanceCriteria: ["Implementation is complete", "Code compiles without errors"]

After refinement:
  acceptanceCriteria: [
    "detectNoPrdFlag('ralph --no-prd fix') returns true",
    "detectNoPrdFlag('ralph fix this') returns false",
    "stripNoPrdFlag removes --no-prd and trims whitespace",
    "TypeScript compiles with no errors (npm run build)"
  ]
```
Why good: Generic criteria replaced with specific, testable criteria.
</Good>

<Good>
Correct parallel delegation:
```
Task(subagent_type="oh-my-claudecode:executor", model="haiku", prompt="Add type export for UserConfig")
Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="Implement the caching layer for API responses")
Task(subagent_type="oh-my-claudecode:executor", model="opus", prompt="Refactor auth module to support OAuth2 flow")
```
Why good: Three independent tasks fired simultaneously at appropriate tiers.
</Good>

<Good>
Story-by-story verification:
```
1. Story US-001: "Add flag detection helpers"
   - Criterion: "detectNoPrdFlag returns true for --no-prd" → Run test → PASS
   - Criterion: "TypeScript compiles" → Run build → PASS
   - Mark US-001 passes: true
2. Story US-002: "Wire PRD into bridge.ts"
   - Continue to next story...
```
Why good: Each story verified against its own acceptance criteria before marking complete.
</Good>

<Bad>
Claiming completion without PRD verification:
"All the changes look good, the implementation should work correctly. Task complete."
Why bad: Uses "should" and "look good" -- no fresh evidence, no story-by-story verification, no architect review.
</Bad>

<Bad>
Keeping generic acceptance criteria:
"prd.json created with criteria: Implementation is complete, Code compiles. Moving on to coding."
Why bad: Did not refine scaffold criteria into task-specific ones. This is PRD theater.
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
- [ ] All prd.json stories have `passes: true` (no incomplete stories)
- [ ] prd.json acceptance criteria are task-specific (not generic boilerplate)
- [ ] All requirements from the original task are met (no scope reduction)
- [ ] Zero pending or in_progress TODO items
- [ ] Fresh test run output shows all tests pass
- [ ] Fresh build output shows success
- [ ] lsp_diagnostics shows 0 errors on affected files
- [ ] progress.txt records implementation details and learnings
- [ ] Architect verification passed (STANDARD tier minimum) against specific acceptance criteria
- [ ] `/oh-my-claudecode:cancel` run for clean state cleanup
</Final_Checklist>

<Advanced>
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
