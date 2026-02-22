---
name: plan
description: Strategic planning with optional interview workflow
---

<Purpose>
Plan creates comprehensive, actionable work plans through intelligent interaction. It auto-detects whether to interview the user (broad requests) or plan directly (detailed requests), and supports consensus mode (iterative Planner/Architect/Critic loop) and review mode (Critic evaluation of existing plans).
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
</Execution_Policy>

<Steps>

### Mode Selection

| Mode | Trigger | Behavior |
|------|---------|----------|
| Interview | Default for broad requests | Interactive requirements gathering |
| Direct | `--direct`, or detailed request | Skip interview, generate plan directly |
| Consensus | `--consensus`, "ralplan" | Planner -> Architect -> Critic loop until agreement; add `--interactive` for user prompts at draft and approval steps |
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

1. **Planner** creates initial plan
2. **User feedback** *(--interactive only)*: If running with `--interactive`, **MUST** use `AskUserQuestion` to present the draft plan with these options:
   - **Proceed to review** — send to Architect and Critic for evaluation
   - **Request changes** — return to step 1 with user feedback incorporated
   - **Skip review** — go directly to final approval (step 7)
   If NOT running with `--interactive`, automatically proceed to review (step 3).
3. **Architect** reviews for architectural soundness (prefer `ask_codex` with `architect` role). **Wait for this step to complete before proceeding to step 4.** Do NOT run steps 3 and 4 in parallel — parallel `ask_codex` calls can trigger a sibling cascade failure if one receives a 429 rate-limit error. If `ask_codex` fails with a rate-limit or 429 error, wait 5–10 seconds and retry once; if it fails again, fall back to spawning a `Task` with `subagent_type="oh-my-claudecode:architect"`.
4. **Critic** evaluates against quality criteria (prefer `ask_codex` with `critic` role). Run only after step 3 is complete. Apply the same retry/fallback rule: on rate-limit error, retry once after a short delay; on second failure, fall back to `Task` with `subagent_type="oh-my-claudecode:critic"`.
5. **Re-review loop** (max 5 iterations): If Critic rejects, execute this closed loop:
   a. Collect all rejection feedback from Architect + Critic
   b. Pass feedback to Planner to produce a revised plan
   c. **Return to Step 3** — Architect reviews the revised plan
   d. **Return to Step 4** — Critic evaluates the revised plan
   e. Repeat until Critic approves OR max 5 iterations reached
   f. If max iterations reached without approval, present the best version to user via `AskUserQuestion` with note that expert consensus was not reached
6. **Apply improvements**: When reviewers approve with improvement suggestions, merge all accepted improvements into the plan file before proceeding. Specifically:
   a. Collect all improvement suggestions from Architect and Critic responses
   b. Deduplicate and categorize the suggestions
   c. Update the plan file in `.omc/plans/` with the accepted improvements (add missing details, refine steps, strengthen acceptance criteria, etc.)
   d. Note which improvements were applied in a brief changelog section at the end of the plan
7. On Critic approval (with improvements applied): *(--interactive only)* If running with `--interactive`, use `AskUserQuestion` to present the plan with these options:
   - **Approve and execute** — proceed to implementation via ralph+ultrawork
   - **Approve and implement via team** — proceed to implementation via coordinated parallel team agents
   - **Clear context and implement** — compact the context window first (recommended when context is large after planning), then start fresh implementation via ralph with the saved plan file
   - **Request changes** — return to step 1 with user feedback
   - **Reject** — discard the plan entirely
   If NOT running with `--interactive`, output the final approved plan and stop. Do NOT auto-execute.
8. *(--interactive only)* User chooses via the structured `AskUserQuestion` UI (never ask for approval in plain text)
9. On user approval (--interactive only):
   - **Approve and execute**: **MUST** invoke `Skill("oh-my-claudecode:ralph")` with the approved plan path from `.omc/plans/` as context. Do NOT implement directly. Do NOT edit source code files in the planning agent. The ralph skill handles execution via ultrawork parallel agents.
   - **Approve and implement via team**: **MUST** invoke `Skill("oh-my-claudecode:team")` with the approved plan path from `.omc/plans/` as context. Do NOT implement directly. The team skill coordinates parallel agents across the staged pipeline for faster execution on large tasks.
   - **Clear context and implement**: First invoke `Skill("compact")` to compress the context window (reduces token usage accumulated during planning), then invoke `Skill("oh-my-claudecode:ralph")` with the approved plan path from `.omc/plans/`. This path is recommended when the context window is 50%+ full after the planning session.

### Review Mode (`--review`)

1. Read plan file from `.omc/plans/`
2. Evaluate via Critic (prefer `ask_codex` with `critic` role)
3. Return verdict: APPROVED, REVISE (with specific feedback), or REJECT (replanning required)

### Plan Output Format

Every plan includes:
- Requirements Summary
- Acceptance Criteria (testable)
- Implementation Steps (with file references)
- Risks and Mitigations
- Verification Steps

Plans are saved to `.omc/plans/`. Drafts go to `.omc/drafts/`.
</Steps>

<Tool_Usage>
- Before first MCP tool use, run the 3-step discovery: (1) `ToolSearch("mcp")`, (2) select the full name from results (e.g., `mcp__x__ask_codex`), (3) fall back to the equivalent Claude agent only if step 1 returns empty. Never use `ToolSearch("ask_codex")` as the primary search -- it can return false negatives even when MCP tools are present.
- Use `AskUserQuestion` for preference questions (scope, priority, timeline, risk tolerance) -- provides clickable UI
- Use plain text for questions needing specific values (port numbers, names, follow-up clarifications)
- Use `explore` agent (Haiku, 30s timeout) to gather codebase facts before asking the user
- Use `ask_codex` with `agent_role: "planner"` for planning validation on large-scope plans
- Use `ask_codex` with `agent_role: "analyst"` for requirements analysis
- Use `ask_codex` with `agent_role: "critic"` for plan review in consensus and review modes
- If ToolSearch finds no MCP tools or Codex is unavailable, fall back to equivalent Claude agents -- never block on external tools
- **CRITICAL — Consensus mode `ask_codex` calls MUST be sequential, never parallel.** Claude Code cancels sibling tool calls when one fails ("Sibling tool call errored"), so running Architect and Critic `ask_codex` calls in the same tool-call batch will cause a cascade failure if either hits a 429 rate-limit. Always await the Architect call result before issuing the Critic call.
- On `ask_codex` rate-limit (429) error: wait 5–10 s and retry once. If the second attempt also fails, fall back to the equivalent Claude agent (`Task` with `subagent_type="oh-my-claudecode:architect"` or `"oh-my-claudecode:critic"`).
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
