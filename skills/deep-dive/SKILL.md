---
name: deep-dive
description: "2-stage pipeline: trace (causal investigation) -> deep-interview (requirements crystallization) with 3-point injection"
argument-hint: "<problem or exploration target>"
triggers:
  - "deep dive"
  - "deep-dive"
  - "trace and interview"
  - "investigate deeply"
pipeline: [deep-dive, omc-plan, autopilot]
next-skill: omc-plan
next-skill-args: --consensus --direct
handoff: .omc/specs/deep-dive-{slug}.md
---

<Purpose>
Deep Dive orchestrates a 2-stage pipeline that first investigates WHY something happened (trace) then precisely defines WHAT to do about it (deep-interview). The trace stage runs 3 parallel causal investigation lanes, and its findings feed into the interview stage via a 3-point injection mechanism — enriching the starting point, providing system context, and seeding initial questions. The result is a crystal-clear spec grounded in evidence, not assumptions.
</Purpose>

<Use_When>
- User has a problem but doesn't know the root cause — needs investigation before requirements
- User says "deep dive", "deep-dive", "investigate deeply", "trace and interview"
- User wants to understand existing system behavior before defining changes
- Bug investigation: "Something broke and I need to figure out why, then plan the fix"
- Feature exploration: "I want to improve X but first need to understand how it currently works"
- The problem is ambiguous, causal, and evidence-heavy — jumping to code would waste cycles
</Use_When>

<Do_Not_Use_When>
- User already knows the root cause and just needs requirements gathering — use `/deep-interview` directly
- User has a clear, specific request with file paths and function names — execute directly
- User wants to trace/investigate but NOT define requirements afterward — use `/trace` directly
- User already has a PRD or spec — use `/ralph` or `/autopilot` with that plan
- User says "just do it" or "skip the investigation" — respect their intent
</Do_Not_Use_When>

<Why_This_Exists>
Users who run `/trace` and `/deep-interview` separately lose context between steps. Trace discovers root causes, maps system areas, and identifies critical unknowns — but when the user manually starts `/deep-interview` afterward, none of that context carries over. The interview starts from scratch, re-exploring the codebase and asking questions the trace already answered.

Deep Dive connects these steps with a 3-point injection mechanism that transfers trace findings directly into the interview's initialization. This means the interview starts with an enriched understanding, skips redundant exploration, and focuses its first questions on what the trace couldn't resolve autonomously.

The name "deep dive" naturally implies this flow: first dig deep into the problem's causal structure, then use those findings to precisely define what to do about it.
</Why_This_Exists>

<Execution_Policy>
- Phase 1-2: Initialize and confirm trace lane hypotheses (1 user interaction)
- Phase 3: Trace runs autonomously after lane confirmation — no mid-trace interruption
- Phase 4: Interview is interactive — one question at a time, following deep-interview protocol
- State persists across phases via `state_write(mode="deep-interview")` with `source: "deep-dive"` discriminator
- Artifact paths are persisted in state for resume resilience after context compaction
- Do not proceed to execution — always hand off via Execution Bridge (Phase 5)
</Execution_Policy>

<Steps>

## Phase 1: Initialize

1. **Parse the user's idea** from `{{ARGUMENTS}}`
2. **Generate slug**: kebab-case from first 5 words of ARGUMENTS, lowercased, special characters stripped. Example: "Why does the auth token expire early?" becomes `why-does-the-auth-token`
3. **Detect brownfield vs greenfield**:
   - Run `explore` agent (haiku): check if cwd has existing source code, package files, or git history
   - If source files exist AND the user's idea references modifying/extending something: **brownfield**
   - Otherwise: **greenfield**
4. **Generate 3 trace lane hypotheses**:
   - Default lanes (unless the problem strongly suggests a better partition):
     1. **Code-path / implementation cause**
     2. **Config / environment / orchestration cause**
     3. **Measurement / artifact / assumption mismatch cause**
   - For brownfield: run `explore` agent to identify relevant codebase areas, informing hypothesis generation
5. **Initialize state** via `state_write(mode="deep-interview")`:

```json
{
  "active": true,
  "current_phase": "lane-confirmation",
  "state": {
    "source": "deep-dive",
    "session_id": "<uuid>",
    "slug": "<kebab-case-slug>",
    "initial_idea": "<user input>",
    "type": "brownfield|greenfield",
    "trace_lanes": ["<hypothesis1>", "<hypothesis2>", "<hypothesis3>"],
    "trace_result": null,
    "trace_path": null,
    "spec_path": null,
    "interview_rounds": [],
    "current_ambiguity": 1.0,
    "threshold": 0.2
  }
}
```

## Phase 2: Lane Confirmation

Present the 3 hypotheses to the user via `AskUserQuestion` for confirmation (1 round only):

> **Starting deep dive.** I'll first investigate your problem through 3 parallel trace lanes, then use the findings to conduct a targeted interview for requirements crystallization.
>
> **Your problem:** "{initial_idea}"
> **Project type:** {greenfield|brownfield}
>
> **Proposed trace lanes:**
> 1. {hypothesis_1}
> 2. {hypothesis_2}
> 3. {hypothesis_3}
>
> Are these hypotheses appropriate, or would you like to adjust them?

**Options:**
- Confirm and start trace
- Adjust hypotheses (user provides alternatives)

After confirmation, update state to `current_phase: "trace-executing"`.

## Phase 3: Trace Execution

Run the trace autonomously using the `oh-my-claudecode:trace` skill's behavioral contract.

### Team Mode Orchestration

Use **Claude built-in team mode** to run 3 parallel tracer lanes:

1. **Restate the observed result** or "why" question precisely
2. **Spawn 3 tracer lanes** — one per confirmed hypothesis
3. Each tracer worker must:
   - Own exactly one hypothesis lane
   - Gather evidence **for** the lane
   - Gather evidence **against** the lane
   - Rank evidence strength (from controlled reproductions → speculation)
   - Name the **critical unknown** for the lane
   - Recommend the best **discriminating probe**
4. **Run a rebuttal round** between the leading hypothesis and the strongest alternative
5. **Detect convergence**: if two "different" hypotheses reduce to the same mechanism, merge them explicitly
6. **Leader synthesis**: produce the ranked output below

**Team mode fallback**: If team mode is unavailable or fails, fall back to sequential lane execution: run each lane's investigation serially, then synthesize results. The output structure remains identical — only the parallelism is lost.

### Trace Output Structure

Save to `.omc/specs/deep-dive-trace-{slug}.md`:

```markdown
# Deep Dive Trace: {slug}

## Observed Result
[What was actually observed / the problem statement]

## Ranked Hypotheses
| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | ... | High/Medium/Low | Strong/Moderate/Weak | ... |
| 2 | ... | ... | ... | ... |
| 3 | ... | ... | ... | ... |

## Evidence Summary by Hypothesis
- **Hypothesis 1**: ...
- **Hypothesis 2**: ...
- **Hypothesis 3**: ...

## Evidence Against / Missing Evidence
- **Hypothesis 1**: ...
- **Hypothesis 2**: ...
- **Hypothesis 3**: ...

## Rebuttal Round
- Best rebuttal to leader: ...
- Why leader held / failed: ...

## Convergence / Separation Notes
- ...

## Most Likely Explanation
[Current best explanation — may be "insufficient evidence" if all lanes are low-confidence]

## Critical Unknown
[Single missing fact keeping uncertainty open]

## Recommended Discriminating Probe
[Single next probe that would collapse uncertainty fastest]
```

After saving:
- Persist `trace_path` in state: `state_write` with `state.trace_path = ".omc/specs/deep-dive-trace-{slug}.md"`
- Update `current_phase: "trace-complete"`

## Phase 4: Interview with Trace Injection

### Architecture: Reference-not-Copy

Phase 4 follows the `oh-my-claudecode:deep-interview` SKILL.md Phases 2-4 (Interview Loop, Challenge Agents, Crystallize Spec) as the base behavioral contract. The executor MUST read the deep-interview SKILL.md to understand the full interview protocol. Deep-dive does NOT duplicate the interview protocol — it specifies exactly **3 initialization overrides**:

### 3-Point Injection (the core differentiator)

**Override 1 — initial_idea enrichment**: Replace deep-interview's raw `{{ARGUMENTS}}` initialization with:

```
Original problem: {ARGUMENTS}
Trace finding: {most_likely_explanation from trace synthesis}
Given this root cause/analysis, what should we do about it?
```

**Override 2 — codebase_context replacement**: Skip deep-interview's Phase 1 brownfield explore step. Instead, set `codebase_context` to the full trace synthesis. The trace already mapped the relevant system areas with evidence — re-exploring would be redundant.

**Override 3 — initial question queue injection**: Extract `critical_unknowns` from trace result. These become the interview's first 1-3 questions before normal Socratic questioning (from deep-interview's Phase 2) resumes:

```
Trace identified these unresolved questions:
1. {critical_unknown_1}
2. {critical_unknown_2}
Ask these FIRST, then continue with normal ambiguity-driven questioning.
```

### Low-Confidence Trace Handling

If the trace produces no clear "most likely explanation" (all lanes low-confidence or contradictory):
- **Override 1**: Use original user input without enrichment — do not inject an uncertain conclusion
- **Override 2**: Still inject the trace synthesis — even inconclusive findings provide structural context about the system areas investigated
- **Override 3**: Inject ALL lanes' critical unknowns (not just top-ranked) — more open questions are more useful when the trace is uncertain, as they guide the interview toward the gaps

### Interview Loop

Follow deep-interview SKILL.md Phases 2-4 exactly:
- Ambiguity scoring across all dimensions (same weights as deep-interview)
- One question at a time targeting the weakest dimension
- Challenge agents activate at the same round thresholds as deep-interview
- Soft/hard caps at the same round limits as deep-interview
- Score display after every round

No overrides to the interview mechanics themselves — only the 3 initialization points above.

### Spec Generation

When ambiguity ≤ threshold (default 0.2), generate the spec in **standard deep-interview format** with one addition:

- All standard sections: Goal, Constraints, Non-Goals, Acceptance Criteria, Assumptions Exposed, Technical Context, Ontology, Interview Transcript
- **Additional section: "Trace Findings"** — summarizes the trace results (most likely explanation, critical unknowns resolved, evidence that shaped the interview)
- Save to `.omc/specs/deep-dive-{slug}.md`
- Persist `spec_path` in state: `state_write` with `state.spec_path = ".omc/specs/deep-dive-{slug}.md"`
- Update `current_phase: "spec-complete"`

## Phase 5: Execution Bridge

Read `spec_path` and `trace_path` from state (not conversation context) for resume resilience.

Present execution options via `AskUserQuestion`:

**Question:** "Your spec is ready (ambiguity: {score}%). How would you like to proceed?"

**Options:**

1. **Ralplan → Autopilot (Recommended)**
   - Description: "3-stage pipeline: consensus-refine this spec with Planner/Architect/Critic, then execute with full autopilot. Maximum quality."
   - Action: Invoke `Skill("oh-my-claudecode:omc-plan")` with `--consensus --direct` flags and the spec file path (`spec_path` from state) as context.

2. **Execute with autopilot (skip ralplan)**
   - Description: "Full autonomous pipeline — planning, parallel implementation, QA, validation. Faster but without consensus refinement."
   - Action: Invoke `Skill("oh-my-claudecode:autopilot")` with the spec file path as context.

3. **Execute with ralph**
   - Description: "Persistence loop with architect verification — keeps working until all acceptance criteria pass."
   - Action: Invoke `Skill("oh-my-claudecode:ralph")` with the spec file path as the task definition.

4. **Execute with team**
   - Description: "N coordinated parallel agents — fastest execution for large specs."
   - Action: Invoke `Skill("oh-my-claudecode:team")` with the spec file path as the shared plan.

5. **Refine further**
   - Description: "Continue interviewing to improve clarity (current: {score}%)."
   - Action: Return to Phase 4 interview loop.

**IMPORTANT:** On execution selection, **MUST** invoke the chosen skill via `Skill()` with explicit `spec_path`. Do NOT implement directly. The deep-dive skill is a requirements pipeline, not an execution agent.

</Steps>

<Tool_Usage>
- Use `AskUserQuestion` for lane confirmation (Phase 2) and each interview question (Phase 4)
- Use `Agent(subagent_type="oh-my-claudecode:explore", model="haiku")` for brownfield codebase exploration (Phase 1)
- Use Claude built-in team mode for 3 parallel tracer lanes (Phase 3)
- Use `state_write(mode="deep-interview")` with `state.source = "deep-dive"` for all state persistence
- Use `state_read(mode="deep-interview")` for resume — check `state.source === "deep-dive"` to distinguish
- Use `Write` tool to save trace result and final spec to `.omc/specs/`
- Use `Skill()` to bridge to execution modes (Phase 5) — never implement directly
</Tool_Usage>

<Examples>
<Good>
Bug investigation with trace-to-interview flow:
```
User: /deep-dive "Production DAG fails intermittently on the transformation step"

[Phase 1] Detected brownfield. Generated 3 hypotheses:
  1. Code-path: transformation SQL has a race condition with concurrent writes
  2. Config/env: resource limits cause OOM kills under high data volume
  3. Measurement: retry logic masks the real error, making failures appear intermittent

[Phase 2] User confirms hypotheses.

[Phase 3] Trace runs 3 parallel lanes.
  Synthesis: Most likely = OOM kill (lane 2, High confidence)
  Critical unknown: exact memory threshold vs. data volume correlation

[Phase 4] Interview starts with injected context:
  "Trace found OOM kills as the most likely cause. Given this, what should we do?"
  First question from critical unknown: "What's the expected data volume range
  for this DAG, and is there a peak period?"
  → Interview continues until ambiguity ≤ 20%

[Phase 5] Spec ready. User selects ralplan → autopilot.
```
Why good: Trace findings directly shaped the interview. The interview didn't re-explore the codebase or ask "what could be wrong?" — it started from the trace conclusion.
</Good>

<Good>
Feature exploration with low-confidence trace:
```
User: /deep-dive "I want to improve our authentication flow"

[Phase 3] Trace runs but all lanes are low-confidence (exploration, not bug).
  Most likely explanation: "Insufficient evidence — this is an exploration, not a bug"
  Critical unknowns: JWT refresh timing, session storage mechanism, OAuth2 provider selection

[Phase 4] Interview starts WITHOUT initial_idea enrichment (low confidence).
  codebase_context = trace synthesis (mapped auth system structure)
  First questions from ALL lanes' critical unknowns (3 questions).
  → Graceful degradation: interview drives the exploration forward.
```
Why good: Low-confidence trace didn't inject a misleading conclusion. Instead, it provided structural context and seeded questions for the interview to resolve.
</Good>

<Bad>
Skipping lane confirmation:
```
User: /deep-dive "Fix the login bug"
[Phase 1] Generated hypotheses.
[Phase 3] Immediately starts trace without showing hypotheses to user.
```
Why bad: Skipped Phase 2. The user might know that the bug is definitely not config-related, wasting a trace lane on the wrong hypothesis.
</Bad>

<Bad>
Duplicating deep-interview protocol inline:
```
[Phase 4] Defines ambiguity weights: Goal 40%, Constraints 30%, Criteria 30%
Defines challenge agents: Contrarian at round 4, Simplifier at round 6...
```
Why bad: Duplicates deep-interview's behavioral contract. These values should be inherited by referencing deep-interview SKILL.md Phases 2-4, not copied. Copying causes drift when deep-interview updates.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- **Trace timeout**: If trace lanes take unusually long, warn the user and offer to proceed with partial results
- **All lanes inconclusive**: Proceed to interview with graceful degradation (see Low-Confidence Trace Handling)
- **User says "skip trace"**: Allow skipping to Phase 4 with a warning that interview will have no trace context (effectively becomes standalone deep-interview)
- **User says "stop", "cancel", "abort"**: Stop immediately, save state for resume
- **Interview ambiguity stalls**: Follow deep-interview's escalation rules (challenge agents, ontologist mode, hard cap)
- **Context compaction**: All artifact paths persisted in state — resume by reading state, not conversation history
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] SKILL.md has valid YAML frontmatter with name, triggers, pipeline, handoff
- [ ] Phase 1 detects brownfield/greenfield and generates 3 hypotheses
- [ ] Phase 2 confirms hypotheses via AskUserQuestion (1 round)
- [ ] Phase 3 runs trace with 3 parallel lanes (team mode, sequential fallback)
- [ ] Phase 3 saves trace result to `.omc/specs/deep-dive-trace-{slug}.md`
- [ ] Phase 4 starts with 3-point injection (initial_idea, codebase_context, question_queue)
- [ ] Phase 4 references deep-interview SKILL.md Phases 2-4 (not duplicated inline)
- [ ] Phase 4 handles low-confidence trace gracefully
- [ ] Final spec saved to `.omc/specs/deep-dive-{slug}.md` in standard deep-interview format
- [ ] Final spec contains "Trace Findings" section
- [ ] Phase 5 execution bridge passes spec_path explicitly to downstream skills
- [ ] State uses `mode="deep-interview"` with `state.source = "deep-dive"` discriminator
- [ ] `slug`, `trace_path`, `spec_path` persisted in state for resume resilience
</Final_Checklist>

<Advanced>
## Configuration

Optional settings in `.claude/settings.json`:

```json
{
  "omc": {
    "deepDive": {
      "ambiguityThreshold": 0.2,
      "defaultTraceLanes": 3,
      "enableTeamMode": true,
      "sequentialFallback": true
    }
  }
}
```

## Resume

If interrupted, run `/deep-dive` again. The skill reads state from `state_read(mode="deep-interview")` and checks `state.source === "deep-dive"` to resume from the last completed phase. Artifact paths (`trace_path`, `spec_path`) are reconstructed from state, not conversation history.

## Integration with Existing Pipeline

Deep-dive's output (`.omc/specs/deep-dive-{slug}.md`) feeds into the standard omc pipeline:

```
/deep-dive "problem"
  → Trace (3 parallel lanes) + Interview (Socratic Q&A)
  → Spec: .omc/specs/deep-dive-{slug}.md

  → /omc-plan --consensus --direct (spec as input)
    → Planner/Architect/Critic consensus
    → Plan: .omc/plans/ralplan-*.md

  → /autopilot (plan as input, skip Phase 0+1)
    → Execution → QA → Validation
    → Working code
```

The execution bridge passes `spec_path` explicitly to downstream skills. autopilot/ralph/team receive the path as a Skill() argument, so filename-pattern matching is not required.

## Relationship to Standalone Skills

| Scenario | Use |
|----------|-----|
| Know the cause, need requirements | `/deep-interview` directly |
| Need investigation only, no requirements | `/trace` directly |
| Need investigation THEN requirements | `/deep-dive` (this skill) |
| Have requirements, need execution | `/autopilot` or `/ralph` |

Deep-dive is an orchestrator — it does not replace `/trace` or `/deep-interview` as standalone skills.
</Advanced>
