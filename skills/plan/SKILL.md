---
name: omc-plan
description: Strategic planning with optional interview workflow
---

<Purpose>
Plan creates comprehensive, actionable work plans through intelligent interaction. It auto-detects whether to interview the user (broad requests) or plan directly (detailed requests), and supports consensus mode (iterative Planner/Architect/Critic loop with RALPLAN-DR structured deliberation) and review mode (Critic evaluation of existing plans).
</Purpose>

<Use_When>
- User wants to plan before implementing -- "plan this", "plan the", "let's plan"
- User wants structured requirements gathering for a vague idea
- User wants an existing plan reviewed -- "review this plan", `--review`
- User wants multi-perspective consensus on a plan -- `--consensus`, "ralplan"
- Task is broad or vague and needs scoping before any code is written
</Use_When>

<Do_Not_Use_When>
- User wants autonomous end-to-end execution -- use `autopilot` instead
- User wants to start coding immediately with a clear task -- use `ralph` or delegate to executor
- User asks a simple question that can be answered directly -- just answer it
- Task is a single focused fix with obvious scope -- skip planning, just do it
</Do_Not_Use_When>

<Why_This_Exists>
Jumping into code without understanding requirements leads to rework, scope creep, and missed edge cases. Plan provides structured requirements gathering, expert analysis, and quality-gated plans so that execution starts from a solid foundation. The consensus mode adds multi-perspective validation for high-stakes projects.
</Why_This_Exists>

<Execution_Policy>
- Auto-detect interview vs direct mode based on request specificity
- Ask one question at a time during interviews -- never batch multiple questions
- Gather codebase facts via `explore` agent before asking the user about them
- Plans must meet quality standards: 80%+ claims cite file/line, 90%+ criteria are testable
- Consensus mode runs fully automated by default; add `--interactive` to enable user prompts at draft review and final approval steps
- Consensus mode uses RALPLAN-DR short mode by default; switch to deliberate mode with `--deliberate` or when the request explicitly signals high risk (auth/security, data migration, destructive/irreversible changes, production incident, compliance/PII, public API breakage)
</Execution_Policy>

<Steps>

### Mode Selection

| Mode | Trigger | Behavior |
|------|---------|----------|
| Interview | Default for broad requests | Interactive requirements gathering |
| Direct | `--direct`, or detailed request | Skip interview, generate plan directly |
| Consensus | `--consensus`, "ralplan" | Planner -> Architect -> Critic loop until agreement with RALPLAN-DR structured deliberation (short by default, `--deliberate` for high-risk); add `--interactive` for user prompts at draft and approval steps |
| Review | `--review`, "review this plan" | Critic evaluation of existing plan |

### Interview Mode (broad/vague requests)

1. **Classify the request**: Broad (vague verbs, no specific files, touches 3+ areas) triggers interview mode
2. **Ask one focused question** using `AskUserQuestion` for preferences, scope, and constraints
3. **Gather codebase facts first**: Before asking "what patterns does your code use?", spawn an `explore` agent to find out, then ask informed follow-up questions
4. **Build on answers**: Each question builds on the previous answer
5. **Consult Analyst** (Opus) for hidden requirements, edge cases, and risks
6. **Create plan** when the user signals readiness: "create the plan", "I'm ready", "make it a work plan"

### Direct Mode (detailed requests)

1. **Quick Analysis**: Optional brief Analyst consultation
2. **Create plan**: Generate comprehensive work plan immediately
3. **Review** (optional): Critic review if requested

### Consensus Mode (`--consensus` / "ralplan")

**RALPLAN-DR modes**: **Short** (default, bounded structure) and **Deliberate** (for `--deliberate` or explicit high-risk requests). Both modes keep the same Planner -> Architect -> Critic sequence and the same `AskUserQuestion` gates.

1. **Planner** creates initial plan and a compact **RALPLAN-DR summary** before any Architect review. The summary **MUST** include:
   - **Principles** (3-5)
   - **Decision Drivers** (top 3)
   - **Viable Options** (>=2) with bounded pros/cons for each option
   - If only one viable option remains, an explicit **invalidation rationale** for the alternatives that were rejected
   - In **deliberate mode**: a **pre-mortem** (3 failure scenarios) and an **expanded test plan** covering **unit / integration / e2e / observability**
2. **User feedback** *(--interactive only)*: If running with `--interactive`, **MUST** use `AskUserQuestion` to present the draft plan **plus the RALPLAN-DR Principles / Decision Drivers / Options summary for early direction alignment** with these options:
   - **Proceed to review** — send to Architect and Critic for evaluation
   - **Request changes** — return to step 1 with user feedback incorporated
   - **Skip review** — go directly to final approval (step 7)
   If NOT running with `--interactive`, automatically proceed to review (step 3).
3. **Architect** reviews for architectural soundness using `Task(subagent_type="oh-my-claudecode:architect", ...)`. Architect review **MUST** include: strongest steelman counterargument (antithesis) against the favored option, at least one meaningful tradeoff tension, and (when possible) a synthesis path. In deliberate mode, Architect should explicitly flag principle violations. **Wait for this step to complete before proceeding to step 4.** Do NOT run steps 3 and 4 in parallel.
4. **Critic** evaluates against quality criteria using `Task(subagent_type="oh-my-claudecode:critic", ...)`. Critic **MUST** verify principle-option consistency, fair alternative exploration, risk mitigation clarity, testable acceptance criteria, and concrete verification steps. Critic **MUST** explicitly reject shallow alternatives, driver contradictions, vague risks, or weak verification. In deliberate mode, Critic **MUST** reject missing/weak pre-mortem or missing/weak expanded test plan. Run only after step 3 is complete.
5. **Re-review loop** (max 5 iterations): If Critic rejects, execute this closed loop:
   a. Collect all rejection feedback from Architect + Critic
   b. Pass feedback to Planner to produce a revised plan
   c. **Return to Step 3** — Architect reviews the revised plan
   d. **Return to Step 4** — Critic evaluates the revised plan
   e. Repeat until Critic approves OR max 5 iterations reached
   f. If max iterations reached without approval, present the best version to user via `AskUserQuestion` with note that expert consensus was not reached
6. **Apply improvements**: When reviewers approve with improvement suggestions, merge all accepted improvements into the plan file before proceeding. Final consensus output **MUST** include an **ADR** section with: **Decision**, **Drivers**, **Alternatives considered**, **Why chosen**, **Consequences**, **Follow-ups**. Specifically:
   a. Collect all improvement suggestions from Architect and Critic responses
   b. Deduplicate and categorize the suggestions
   c. Update the plan file in `.omc/plans/` with the accepted improvements (add missing details, refine steps, strengthen acceptance criteria, ADR updates, etc.)
   d. Note which improvements were applied in a brief changelog section at the end of the plan
7. On Critic approval (with improvements applied): *(--interactive only)* If running with `--interactive`, use `AskUserQuestion` to present the plan with these options:
   - **Approve and implement via team** (Recommended) — proceed to implementation via coordinated parallel team agents (`/team`). Team is the canonical orchestration surface since v4.1.7.
   - **Approve and execute via ralph** — proceed to implementation via ralph+ultrawork (sequential execution with verification)
   - **Clear context and implement** — compact the context window first (recommended when context is large after planning), then start fresh implementation via ralph with the saved plan file
   - **Request changes** — return to step 1 with user feedback
   - **Reject** — discard the plan entirely
   If NOT running with `--interactive`, output the final approved plan and stop. Do NOT auto-execute.
8. *(--interactive only)* User chooses via the structured `AskUserQuestion` UI (never ask for approval in plain text)
9. On user approval (--interactive only):
   - **Approve and implement via team**: **MUST** invoke `Skill("oh-my-claudecode:team")` with the approved plan path from `.omc/plans/` as context. Do NOT implement directly. The team skill coordinates parallel agents across the staged pipeline for faster execution on large tasks. This is the recommended default execution path.
   - **Approve and execute via ralph**: **MUST** invoke `Skill("oh-my-claudecode:ralph")` with the approved plan path from `.omc/plans/` as context. Do NOT implement directly. Do NOT edit source code files in the planning agent. The ralph skill handles execution via ultrawork parallel agents.
   - **Clear context and implement**: First invoke `Skill("compact")` to compress the context window (reduces token usage accumulated during planning), then invoke `Skill("oh-my-claudecode:ralph")` with the approved plan path from `.omc/plans/`. This path is recommended when the context window is 50%+ full after the planning session.

### Review Mode (`--review`)

1. Read plan file from `.omc/plans/`
2. Evaluate via Critic using `Task(subagent_type="oh-my-claudecode:critic", ...)`
3. Return verdict: APPROVED, REVISE (with specific feedback), or REJECT (replanning required)

### Plan Output Format

Every plan includes:
- Requirements Summary
- Acceptance Criteria (testable)
- Implementation Steps (with file references)
- Risks and Mitigations
- Verification Steps
- For consensus/ralplan: **RALPLAN-DR summary** (Principles, Decision Drivers, Options)
- For consensus/ralplan final output: **ADR** (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups)
- For deliberate consensus mode: **Pre-mortem (3 scenarios)** and **Expanded Test Plan** (unit/integration/e2e/observability)

Plans are saved to `.omc/plans/`. Drafts go to `.omc/drafts/`.
</Steps>

<Tool_Usage>
- Use `AskUserQuestion` for preference questions (scope, priority, timeline, risk tolerance) -- provides clickable UI
- Use plain text for questions needing specific values (port numbers, names, follow-up clarifications)
- Use `explore` agent (Haiku, 30s timeout) to gather codebase facts before asking the user
- Use `Task(subagent_type="oh-my-claudecode:planner", ...)` for planning validation on large-scope plans
- Use `Task(subagent_type="oh-my-claudecode:analyst", ...)` for requirements analysis
- Use `Task(subagent_type="oh-my-claudecode:critic", ...)` for plan review in consensus and review modes
- **CRITICAL — Consensus mode agent calls MUST be sequential, never parallel.** Always await the Architect Task result before issuing the Critic Task.
- In consensus mode, default to RALPLAN-DR short mode; enable deliberate mode on `--deliberate` or explicit high-risk signals (auth/security, migrations, destructive changes, production incidents, compliance/PII, public API breakage)
- In consensus mode with `--interactive`: use `AskUserQuestion` for the user feedback step (step 2) and the final approval step (step 7) -- never ask for approval in plain text. Without `--interactive`, skip both prompts and output the final plan.
- In consensus mode with `--interactive`, on user approval **MUST** invoke `Skill("oh-my-claudecode:ralph")` for execution (step 9) -- never implement directly in the planning agent
- When user selects "Clear context and implement" in step 7 (--interactive only): invoke `Skill("compact")` first to compress the accumulated planning context, then immediately invoke `Skill("oh-my-claudecode:ralph")` with the plan path -- the compact step is critical to free up context before the implementation loop begins
</Tool_Usage>

<Examples>
<Good>
Adaptive interview (gathering facts before asking):
```
Planner: [spawns explore agent: "find authentication implementation"]
Planner: [receives: "Auth is in src/auth/ using JWT with passport.js"]
Planner: "I see you're using JWT authentication with passport.js in src/auth/.
         For this new feature, should we extend the existing auth or add a separate auth flow?"
```
Why good: Answers its own codebase question first, then asks an informed preference question.
</Good>

<Good>
Single question at a time:
```
Q1: "What's the main goal?"
A1: "Improve performance"
Q2: "For performance, what matters more -- latency or throughput?"
A2: "Latency"
Q3: "For latency, are we optimizing for p50 or p99?"
```
Why good: Each question builds on the previous answer. Focused and progressive.
</Good>

<Bad>
Asking about things you could look up:
```
Planner: "Where is authentication implemented in your codebase?"
User: "Uh, somewhere in src/auth I think?"
```
Why bad: The planner should spawn an explore agent to find this, not ask the user.
</Bad>

<Bad>
Batching multiple questions:
```
"What's the scope? And the timeline? And who's the audience?"
```
Why bad: Three questions at once causes shallow answers. Ask one at a time.
</Bad>

<Bad>
Presenting all design options at once:
```
"Here are 4 approaches: Option A... Option B... Option C... Option D... Which do you prefer?"
```
Why bad: Decision fatigue. Present one option with trade-offs, get reaction, then present the next.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- Stop interviewing when requirements are clear enough to plan -- do not over-interview
- In consensus mode, stop after 5 Planner/Architect/Critic iterations and present the best version
- Consensus mode without `--interactive` outputs the final plan and stops; with `--interactive`, requires explicit user approval before any implementation begins
- If the user says "just do it" or "skip planning", **MUST** invoke `Skill("oh-my-claudecode:ralph")` to transition to execution mode. Do NOT implement directly in the planning agent.
- Escalate to the user when there are irreconcilable trade-offs that require a business decision
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Plan has testable acceptance criteria (90%+ concrete)
- [ ] Plan references specific files/lines where applicable (80%+ claims)
- [ ] All risks have mitigations identified
- [ ] No vague terms without metrics ("fast" -> "p99 < 200ms")
- [ ] Plan saved to `.omc/plans/`
- [ ] In consensus mode: RALPLAN-DR summary includes 3-5 principles, top 3 drivers, and >=2 viable options (or explicit invalidation rationale)
- [ ] In consensus mode final output: ADR section included (Decision / Drivers / Alternatives considered / Why chosen / Consequences / Follow-ups)
- [ ] In deliberate consensus mode: pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability) included
- [ ] In consensus mode with `--interactive`: user explicitly approved before any execution; without `--interactive`: plan output only, no auto-execution
</Final_Checklist>

<Advanced>
## Design Option Presentation

When presenting design choices during interviews, chunk them:

1. **Overview** (2-3 sentences)
2. **Option A** with trade-offs
3. [Wait for user reaction]
4. **Option B** with trade-offs
5. [Wait for user reaction]
6. **Recommendation** (only after options discussed)

Format for each option:
```
### Option A: [Name]
**Approach:** [1 sentence]
**Pros:** [bullets]
**Cons:** [bullets]

What's your reaction to this approach?
```

## Question Classification

Before asking any interview question, classify it:

| Type | Examples | Action |
|------|----------|--------|
| Codebase Fact | "What patterns exist?", "Where is X?" | Explore first, do not ask user |
| User Preference | "Priority?", "Timeline?" | Ask user via AskUserQuestion |
| Scope Decision | "Include feature Y?" | Ask user |
| Requirement | "Performance constraints?" | Ask user |

## Review Quality Criteria

| Criterion | Standard |
|-----------|----------|
| Clarity | 80%+ claims cite file/line |
| Testability | 90%+ criteria are concrete |
| Verification | All file refs exist |
| Specificity | No vague terms |

## Deprecation Notice

The separate `/planner`, `/ralplan`, and `/review` skills have been merged into `/plan`. All workflows (interview, direct, consensus, review) are available through `/plan`.
</Advanced>
