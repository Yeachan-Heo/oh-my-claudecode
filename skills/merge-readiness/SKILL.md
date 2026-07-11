---
name: merge-readiness
aliases: understanding-gate
description: "Post-task merge readiness gate with a state-backed explanation report and human explainability quiz"
argument-hint: "[--quick|--standard|--deep] [--from-diff|--from-artifacts] <change summary or artifact path>"
---

<Purpose>
Merge Readiness is a post-task explainability gate. After implementation, tests, QA, and review evidence exist, it generates a human-readable explanation of the change, then asks the human targeted questions to verify they can explain why the change exists, what changed, what tradeoffs were made, what risks were considered, and how the team should understand it.
</Purpose>

<Use_When>
- A task, PR, or change set is functionally complete and needs a final human-understanding check before merge readiness
- Tests, QA, code review, security review, or other verification has already run, or missing evidence must be explicitly recorded
- The user wants AI to explain the change and then quiz the human on whether they can explain it
- You need a durable session audit record showing why the team can trust and understand the change before asking for merge approval
</Use_When>

<Do_Not_Use_When>
- Requirements are still unclear before implementation; use `/deep-interview`
- The implementation is not done; use `/ralph`, `/team`, or `/autopilot`
- Tests or QA have not run and the user expects this command to replace them
- The user wants code review findings; use `/review` or the relevant review workflow
</Do_Not_Use_When>

<Why_This_Exists>
Real delivery is not only code that works. Teams need to understand why a change exists, what changed, what was deliberately not done, which risks were considered, and what future maintainers should believe about the change. This workflow makes that understanding explicit before merge approval is requested. Passing this gate never means the change is approved or merged; it only means a human can explain it.
</Why_This_Exists>

<Depth_Profiles>
- **Quick (`--quick`)**: small/local changes; correctness threshold `>= 0.70`; max 3 MCQs; required dimensions: why / change / risk
- **Standard (`--standard`, default)**: normal feature/bugfix; correctness threshold `>= 0.80`; max 5 MCQs; required dimensions: why / change / tradeoff / risk / team
- **Deep (`--deep`)**: high-risk, architectural, security, or cross-module changes; correctness threshold `>= 0.90`; max 8 MCQs (redundancy across all five dimensions)

If no flag is provided, use **Standard**. Thresholds and round counts are canonical in `src/hooks/merge-readiness/mcq.ts` and must stay in sync with this file.
</Depth_Profiles>

<Execution_Policy>
- This is a post-task command. Do not implement code inside this mode.
- Gather repository and artifact evidence before asking the human for facts that can be discovered locally.
- Generate the explanation doc + MCQs in one AI step, then present MCQs one-per-round.
- The runtime (TS hook code) is the backbone: it owns validation, authoritative session state, objective MCQ scoring, and report rendering. The AI owns content generation + MCQ presentation via AskUserQuestion.
- Present each MCQ one-per-round via AskUserQuestion (deep-interview style). Record each selection via the runtime so it is scored objectively.
- Ask about explainability, not implementation trivia.
- Never ask the human to memorize line numbers, variable names, private helper names, or incidental implementation details.
- Score is the objective correctness rate (correct answers / answered), not a keyword heuristic.
- If the correctness rate is below threshold after all required MCQs are answered, mark result `paused` and do not claim merge readiness.
- If key evidence is missing (no diff/change signal), mark result `blocked`.
- Passing this gate does not approve merge, replace tests, replace review, replace security review, accept risk, or bypass maintainer approval.
- Persist state for resume safety under `.omc/state/merge-readiness-state.json` (session-scoped under `.omc/state/sessions/<sessionId>/`). Do not write this file directly.
- v1 is advisory: the gate logic (`checkMergeReadiness`) is not wired to the Stop hook, so an active gate does not block the session. It does not perform or approve a Git merge.
</Execution_Policy>

<Steps>

## Phase 0: Evidence Intake

1. Parse `{{ARGUMENTS}}`, depth profile, source mode (`--from-diff|--from-artifacts`), and derive a task slug. `--from-pr` is unsupported; this workflow uses local evidence only.
2. Collect available evidence (the runtime detects artifacts by FILENAME heuristics; file CONTENTS are never parsed):
   - Local Git diff and commit range
   - Changed files
   - Test/QA/verification artifacts (filenames matching `test|spec|qa|verify|validation`)
   - Review/risk/security/readiness/verdict artifacts (filenames matching `review|risk|security|readiness|verdict`)
   - `.omc/plans/`, `.omc/specs/`, `.omc/interviews/`, `.omc/artifacts/`, `.omc/logs/`, and relevant mode state artifacts (canonical `{mode}-state.json` files under `.omc/state/` that record a real run)
3. Record missing evidence explicitly. Missing evidence is not hidden by a good explanation.

## Phase 1: Initialize

Call the `merge_readiness_start` tool with the change summary to seed state (the runtime parses the `--quick`/`--deep` profile (`--standard` is the default when neither flag is present; it is not a parsed token)). State shape:

```json
{
  "active": true,
  "current_phase": "merge-readiness",
  "phase": "content",
  "profile": "standard",
  "threshold": 0.80,
  "max_rounds": 5,
  "required_dimensions": ["why", "change", "tradeoff", "risk", "team"],
  "questions": [],
  "answers": [],
  "awaiting_content": true,
  "readiness_score": 0,
  "result": "pending"
}
```

`awaiting_content` is true until the AI submits the generated doc + MCQs via `merge_readiness_set_content`.

## Phase 2: Generate Explanation Doc + MCQs (AI content step)

Generate, from the actual diff + evidence (not templates):

1. A 5-section narrative: **Why**, **What Changed**, **Tradeoffs**, **Risks Considered**, **Team Understanding**.
2. A set of MCQs (one correct option each, with `correctOptionId` + optional `rationale`):
   - Up to the profile max rounds (quick 3 / standard 5 / deep 8)
   - Distributed across the required dimensions
   - Testing understanding of THIS change, not implementation trivia

Submit them with `merge_readiness_set_content` (requires an active gate from `merge_readiness_start`; it errors if no gate is active). Do not write the state JSON or invoke internal runtime functions. Invalid content is rejected with recoverable validation errors. The validated content is persisted in the authoritative session state.

Use `merge_readiness_report` to render the five sections, evidence, quiz progress, readiness, and merge boundary directly from state. It is read-only and does not create a file. Correct answers and rationales remain hidden until the attempt is complete; cancellation or override reveals only answered questions.

The Merge Boundary must say: "Passing means the human can explain the change. It does not approve merge, replace tests, replace review, or accept risk."

### Maintainer Override Authority

`/merge-readiness --override <reason>` is accepted only when the MCP server launcher injects an authenticated principal in `OMC_MERGE_READINESS_AUTHENTICATED_PRINCIPAL` and includes that exact principal in the comma-separated `OMC_MERGE_READINESS_MAINTAINERS` allowlist. The caller-provided `session_id` selects the state record only; it is never override authority and is not recorded as `override_owner`.

## Phase 3: Human Quiz Loop (MCQ, one-per-round, deep-interview style)

Present each MCQ one-per-round via AskUserQuestion with the option ids/text as choices, then record the human’s selection with the `merge_readiness_record_answer` tool (questionId + optionId). The runtime scores it objectively and either advances to the next question or finalizes the gate (pass / paused / blocked).

Cover these dimensions before passing (quick = why/change/risk only):

1. **why** - why this change was worth doing
2. **change** - what behavior, workflow, interface, or maintenance model changed
3. **tradeoff** - what was chosen, deferred, or rejected and why
4. **risk** - which risks were considered and what remains risky
5. **team** - how the team should understand and maintain this change

Forbidden question types:

- Function-name trivia
- Line-number trivia
- Variable-name recall
- Private helper memorization
- Any question whose answer does not help a reviewer explain the change

## Phase 4: Score Readiness (runtime-owned, objective)

The runtime computes:

- `readiness_score` = correctness rate = (correct answers) / (answered answers), in [0, 1]
- Per-dimension coverage = whether every required dimension has at least one answered MCQ

Gate results:

- `pass`: all required MCQs answered AND correctness rate >= threshold AND required dimensions covered
- `paused`: all required MCQs answered but correctness rate below threshold (or required dimension uncovered)
- `blocked`: missing minimal evidence (no diff/change signal)

Thresholds: quick `0.70` / standard `0.80` / deep `0.90`.

## Phase 5: Crystallize Result

Persist these fields in the terminal session state and inspect them with `merge_readiness_report`:

- Final readiness score
- Dimension breakdown
- Human answers
- AI assessment
- Result
- Blocking or paused gap
- Next step

## Phase 6: Handoff

If `pass`:
- State that the change may proceed to human merge approval.
- Do not merge.

If `paused`:
- State which explanation dimension is missing.
- Recommend rereading or revising the report and rerunning `/merge-readiness`.

If `blocked`:
- State which evidence must be produced before rerunning.

</Steps>

<Tool_Usage>
- Use repository search and local artifacts for evidence intake before asking the human for context.
- Use structured user questioning when available.
- Use `merge_readiness_start` to initialize the gate, `merge_readiness_set_content` to submit the report + MCQs, `merge_readiness_record_answer` to record each selection, and `merge_readiness_report` to render the current audit record. Use state read/status/clear only for `.omc/state/merge-readiness-state.json`; never use generic state write to submit quiz content. `state_clear` routes merge-readiness through cancellation and preserves terminal state; pass the current session_id to avoid cancelling concurrent quizzes.
</Tool_Usage>

<Escalation_And_Stop_Conditions>
- User says stop/cancel/abort -> persist terminal `cancelled` state and stop.
- Missing diff or change evidence -> `blocked`.
- Human cannot explain a required dimension -> `paused`.
- Readiness threshold reached and mandatory gates satisfied -> `pass`.
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Evidence intake completed
- [ ] Missing evidence recorded
- [ ] Explanation doc (5 sections) + MCQs submitted via merge_readiness_set_content
- [ ] MCQs presented one-per-round via AskUserQuestion
- [ ] Each answer correlated from marked AskUserQuestion output (objective scoring)
- [ ] Questions avoided implementation trivia
- [ ] Correctness rate calculated by the runtime
- [ ] Result is `pass`, `paused`, `blocked`, `overridden`, or `cancelled`
- [ ] Merge Boundary is explicit
- [ ] No direct implementation or merge performed
</Final_Checklist>

<Advanced>
## Recommended Delivery Pipeline

```text
/deep-interview
  -> /omc-plan or /ralplan
  -> /ralph, /team, or /autopilot
  -> /ultraqa and review
  -> /merge-readiness
  -> human merge approval
```

## Autopilot Bridge

Autopilot may call this workflow after QA/validation when configured:

```jsonc
{
  "autopilot": {
    "mergeReadiness": true
  }
}
```

`autopilot.understandingGate` is a deprecated compatibility alias for `autopilot.mergeReadiness`.
</Advanced>

Task: {{ARGUMENTS}}
