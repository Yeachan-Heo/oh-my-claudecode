---
name: autopilot
description: Full autonomous execution from idea to working code
---

<Purpose>
Autopilot takes a brief product idea and autonomously handles the full lifecycle: requirements analysis, technical design, planning, parallel implementation, QA cycling, and multi-perspective validation. It produces working, verified code from a 2-3 line description.
</Purpose>

<Use_When>
- User wants end-to-end autonomous execution from an idea to working code
- User says "autopilot", "auto pilot", "autonomous", "build me", "create me", "make me", "full auto", "handle it all", or "I want a/an..."
- Task requires multiple phases: planning, coding, testing, and validation
- User wants hands-off execution and is willing to let the system run to completion
</Use_When>

<Do_Not_Use_When>
- User wants to explore options or brainstorm -- use `plan` skill instead
- User says "just explain", "draft only", or "what would you suggest" -- respond conversationally
- User wants a single focused code change -- use `ralph` or delegate to an executor agent
- User wants to review or critique an existing plan -- use `plan --review`
- Task is a quick fix or small bug -- use direct executor delegation
</Do_Not_Use_When>

<Why_This_Exists>
Most non-trivial software tasks require coordinated phases: understanding requirements, designing a solution, implementing in parallel, testing, and validating quality. Autopilot orchestrates all of these phases automatically so the user can describe what they want and receive working code without managing each step.
</Why_This_Exists>

<Execution_Policy>
- Each phase must complete before the next begins
- Parallel execution is used within phases where possible (Phase 2 and Phase 4)
- QA cycles repeat up to 5 times; if the same error persists 3 times, stop and report the fundamental issue
- Validation requires approval from all reviewers; rejected items get fixed and re-validated
- Cancel with `/oh-my-claudecode:cancel` at any time; progress is preserved for resume
</Execution_Policy>

<Steps>
1. **Phase 0 - Expansion**: Turn the user's idea into a detailed spec
   - **If ralplan consensus plan exists** (`.omc/plans/ralplan-*.md` or `.omc/plans/consensus-*.md` from the 3-stage pipeline): Skip BOTH Phase 0 and Phase 1 — jump directly to Phase 2 (Execution). The plan has already been Planner/Architect/Critic validated.
   - **If deep-interview spec exists** (`.omc/specs/deep-interview-*.md`): Skip analyst+architect expansion, use the pre-validated spec directly as Phase 0 output. Continue to Phase 1 (Planning).
   - **If input is vague** (no file paths, function names, or concrete anchors): Offer redirect to `/deep-interview` for Socratic clarification before expanding
   - **Otherwise**: Analyst (Opus) extracts requirements, Architect (Opus) creates technical specification
   - Output: `.omc/autopilot/spec.md`

2. **Phase 1 - Planning**: Create an implementation plan from the spec
   - **If ralplan consensus plan exists**: Skip — already done in the 3-stage pipeline
   - Architect (Opus): Create plan (direct mode, no interview)
   - Critic (Opus): Validate plan
   - Output: `.omc/plans/autopilot-impl.md`

3. **Phase 2 - Execution**: Implement the plan using Ralph + Ultrawork
   - Executor-low (Haiku): Simple tasks
   - Executor (Sonnet): Standard tasks
   - Executor-high (Opus): Complex tasks
   - Run independent tasks in parallel

4. **Phase 3 - QA**: Cycle until all tests pass (UltraQA mode)
   - Build, lint, test, fix failures
   - Repeat up to 5 cycles
   - Stop early if the same error repeats 3 times (indicates a fundamental issue)

5. **Phase 4 - Validation**: Multi-perspective review in parallel
   - Architect: Functional completeness
   - Security-reviewer: Vulnerability check
   - Code-reviewer: Quality review
   - All must approve; fix and re-validate on rejection

6. **Phase 5 - Cleanup**: Delete all state files on successful completion
   - Remove `.omc/state/autopilot-state.json`, `ralph-state.json`, `ultrawork-state.json`, `ultraqa-state.json`
   - Run `/oh-my-claudecode:cancel` for clean exit
</Steps>

<Tool_Usage>
- Use `Task(subagent_type="oh-my-claudecode:architect", ...)` for Phase 4 architecture validation
- Use `Task(subagent_type="oh-my-claudecode:security-reviewer", ...)` for Phase 4 security review
- Use `Task(subagent_type="oh-my-claudecode:code-reviewer", ...)` for Phase 4 quality review
- Agents form their own analysis first, then spawn Claude Task agents for cross-validation
- Never block on external tools; proceed with available agents if delegation fails
</Tool_Usage>

<Examples>
<Good>
User: "autopilot A REST API for a bookstore inventory with CRUD operations using TypeScript"
Why good: Specific domain (bookstore), clear features (CRUD), technology constraint (TypeScript). Autopilot has enough context to expand into a full spec.
</Good>

<Good>
User: "build me a CLI tool that tracks daily habits with streak counting"
Why good: Clear product concept with a specific feature. The "build me" trigger activates autopilot.
</Good>

<Bad>
User: "fix the bug in the login page"
Why bad: This is a single focused fix, not a multi-phase project. Use direct executor delegation or ralph instead.
</Bad>

<Bad>
User: "what are some good approaches for adding caching?"
Why bad: This is an exploration/brainstorming request. Respond conversationally or use the plan skill.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- Stop and report when the same QA error persists across 3 cycles (fundamental issue requiring human input)
- Stop and report when validation keeps failing after 3 re-validation rounds
- Stop when the user says "stop", "cancel", or "abort"
- If requirements were too vague and expansion produces an unclear spec, offer redirect to `/deep-interview` for Socratic clarification, or pause and ask the user for clarification before proceeding
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] All 5 phases completed (Expansion, Planning, Execution, QA, Validation)
- [ ] All validators approved in Phase 4
- [ ] Tests pass (verified with fresh test run output)
- [ ] Build succeeds (verified with fresh build output)
- [ ] State files cleaned up
- [ ] User informed of completion with summary of what was built
</Final_Checklist>

<Advanced>
## Configuration

Optional settings in `.claude/settings.json`:

```json
{
  "omc": {
    "autopilot": {
      "maxIterations": 10,
      "maxQaCycles": 5,
      "maxValidationRounds": 3,
      "pauseAfterExpansion": false,
      "pauseAfterPlanning": false,
      "skipQa": false,
      "skipValidation": false
    }
  }
}
```

## Resume

If autopilot was cancelled or failed, run `/oh-my-claudecode:autopilot` again to resume from where it stopped.

## Best Practices for Input

1. Be specific about the domain -- "bookstore" not "store"
2. Mention key features -- "with CRUD", "with authentication"
3. Specify constraints -- "using TypeScript", "with PostgreSQL"
4. Let it run -- avoid interrupting unless truly needed

## Troubleshooting

**Stuck in a phase?** Check TODO list for blocked tasks, review `.omc/autopilot-state.json`, or cancel and resume.

**QA cycles exhausted?** The same error 3 times indicates a fundamental issue. Review the error pattern; manual intervention may be needed.

**Validation keeps failing?** Review the specific issues. Requirements may have been too vague -- cancel and provide more detail.

## Deep Interview Integration

When autopilot is invoked with a vague input, Phase 0 can redirect to `/deep-interview` for Socratic clarification:

```
User: "autopilot build me something cool"
Autopilot: "Your request is open-ended. Would you like to run a deep interview first?"
  [Yes, interview first (Recommended)] [No, expand directly]
```

If a deep-interview spec already exists at `.omc/specs/deep-interview-*.md`, autopilot uses it directly as Phase 0 output (the spec has already been mathematically validated for clarity).

### 3-Stage Pipeline: deep-interview → ralplan → autopilot

The recommended full pipeline chains three quality gates:

```
/deep-interview "vague idea"
  → Socratic Q&A → spec (ambiguity ≤ 20%)
  → /ralplan --direct → consensus plan (Planner/Architect/Critic approved)
  → /autopilot → skips Phase 0+1, starts at Phase 2 (Execution)
```

When autopilot detects a ralplan consensus plan (`.omc/plans/ralplan-*.md` or `.omc/plans/consensus-*.md`), it skips both Phase 0 (Expansion) and Phase 1 (Planning) because the plan has already been:
- Requirements-validated (deep-interview ambiguity gate)
- Architecture-reviewed (ralplan Architect agent)
- Quality-checked (ralplan Critic agent)

Autopilot starts directly at Phase 2 (Execution via Ralph + Ultrawork).
</Advanced>
