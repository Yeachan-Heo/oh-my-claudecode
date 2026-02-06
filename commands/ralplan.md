---
description: Iterative planning with Planner, Architect, and Critic until consensus
aliases: [rp, planloop]
---

# Ralplan Command

[RALPLAN ACTIVATED - ITERATIVE PLANNING CONSENSUS MODE]

## User's Task

{{ARGUMENTS}}

## Overview

Ralplan orchestrates three specialized agents—Planner, Architect, and Critic—in an iterative loop until consensus is reached on a comprehensive work plan. This skill ensures plans are strategically sound, architecturally valid, and thoroughly reviewed before execution.

## The Planning Triad

Three agents collaborate in structured phases to validate and refine work plans:

| Agent | Role | Output |
|-------|------|--------|
| **Planner** | Strategic Planner | Creates/refines the work plan |
| **Architect** | Strategic Advisor | Answers questions, validates architecture |
| **Critic** | Ruthless Reviewer | Critiques and identifies gaps |

## The Iteration Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                       RALPLAN LOOP                              │
│                                                                 │
│    ┌──────────────┐                                             │
│    │   PLANNER    │◄────────────────────────────────┐           │
│    │   (Plans)    │                                 │           │
│    └──────┬───────┘                                 │           │
│           │                                         │           │
│           ▼                                         │           │
│    ┌──────────────┐     Questions?    ┌───────────┐ │           │
│    │   Has open   │─────────────────► │ ARCHITECT │ │           │
│    │  questions?  │                   │ (Advises) │ │           │
│    └──────┬───────┘                   └─────┬─────┘ │           │
│           │                                 │       │           │
│           │ No questions                    │       │           │
│           ▼                                 ▼       │           │
│    ┌──────────────┐                  ┌──────────┐   │           │
│    │    CRITIC    │◄─────────────────│ Answers  │   │           │
│    │  (Reviews)   │                  └──────────┘   │           │
│    └──────┬───────┘                                 │           │
│           │                                         │           │
│           ▼                                         │           │
│    ┌──────────────┐     REJECT      ┌──────────────┐│           │
│    │   Verdict?   │─────────────────►│  Feedback   ││           │
│    └──────┬───────┘                  │ to Planner  │┘           │
│           │                          └─────────────┘            │
│           │ OKAY                                                │
│           ▼                                                     │
│    ┌──────────────────────────────────────────────────────────┐ │
│    │                  PLAN APPROVED                           │ │
│    │         Present plan to user for approval                │ │
│    └───────────────────────┬──────────────────────────────────┘ │
└────────────────────────────┼────────────────────────────────────┘
                             │
                             ▼
                      ┌──────────────┐
                      │  USER GATE   │  ◄── MANDATORY HUMAN-IN-THE-LOOP
                      │  (Approval)  │
                      └──────┬───────┘
                             │
                ┌────────────┼────────────┐
                │            │            │
                ▼            ▼            ▼
          ┌──────────┐ ┌──────────┐ ┌──────────┐
          │ PROCEED  │ │  ADJUST  │ │ DISCARD  │
          │ → ralph  │ │ → replan │ │ → stop   │
          └──────────┘ └──────────┘ └──────────┘
```

## State Management

Ralplan maintains persistent state in `.omc/ralplan-state.json` to track progress and enable recovery across interruptions:

```json
{
  "active": true,
  "mode": "ralplan",
  "iteration": 1,
  "max_iterations": 5,
  "plan_path": ".omc/plans/[feature].md",
  "current_phase": "planner_planning",
  "started_at": "ISO-timestamp",
  "task_description": "[original task]"
}
```

**Phases**: `planner_planning` → `architect_consultation` → `critic_review` → `handling_verdict` → `awaiting_user_approval` → `complete`

## Plan Mode Interaction (CRITICAL)

**When ralplan is invoked while Plan mode is active:**

The Planner agent has a PHASE 3.5 (CONFIRMATION) that normally requires user confirmation before proceeding. **This MUST be bypassed within ralplan because the Critic serves as the reviewer, not the user.**

### Mandatory Constraints

| Constraint | Rationale |
|------------|-----------|
| **Planner MUST skip PHASE 3.5 confirmation** | Critic reviews the plan, not the user |
| **Critic MUST run before any plan approval** | No plan is approved without Critic verdict |
| **DO NOT exit plan mode until Critic has rendered verdict** | Premature exit skips the review step |
| **Log `[RALPLAN] Critic review required before approval`** | Observability for debugging |

### Flow When Plan Mode Is Active

```
1. Orchestrator invokes ralplan skill
2. Log: [RALPLAN] Starting - Critic review will be required
3. Spawn Planner in DIRECT PLANNING MODE (no interview, no confirmation)
4. Planner outputs PLAN_READY: <path>
5. Log: [RALPLAN] Plan ready, invoking Critic for review
6. Spawn Critic with plan path  <-- MUST HAPPEN
7. Critic renders OKAY or REJECT
8. ONLY THEN can plan be approved or refined
```

**CRITICAL: The Critic invocation is MANDATORY. If the Planner completes and signals plan ready, the orchestrator MUST invoke the Critic before any form of plan approval or user confirmation.**

---

## Execution Protocol

### Initialization

The skill begins by establishing the planning environment:

1. Create `.omc/plans/` directory if it doesn't exist
2. Read task description from user input
3. Create `ralplan-state.json` with initial values:
   - `active: true`
   - `iteration: 0`
   - `max_iterations: 5`
   - `current_phase: "planner_planning"`
   - `started_at`: Current ISO timestamp
   - `task_description`: User's task description

### Planner Planning Phase

The Planner creates an initial plan based on task context:

- Invoke Planner in **direct planning mode** (bypassing interview since task context is pre-gathered)
- **CRITICAL: Planner MUST skip PHASE 3.5 (CONFIRMATION)** - the Critic will review, not the user
- Planner receives task context directly without preliminary questioning
- Planner mandatorily consults with Metis for gap detection
- Planner generates plan directly to `.omc/plans/[feature-name].md`
- Plan includes: requirements summary, concrete acceptance criteria, specific implementation steps with file references, risk identification with mitigations, and verification steps
- Signal completion with `PLAN_READY: .omc/plans/[filename].md`
- **After PLAN_READY: DO NOT approve or confirm the plan. Proceed to Critic Review.**
- Extract plan path from completion signal and update state
- Log: `[RALPLAN] Critic review required before approval`

### Architect Consultation (Conditional)

The Architect provides strategic guidance in two scenarios:

1. **After Planner**: If Planner raises architectural questions needing strategic input
2. **After Critic rejection**: If Critic identifies questions requiring expert guidance

When invoked, the Architect receives file paths to read for analysis, not summaries. This enables thorough examination of the existing codebase context before providing recommendations.

### Critic Review (MANDATORY - CANNOT BE SKIPPED)

**CRITICAL: This phase MUST execute. The Critic is the gatekeeper for plan approval.**

Log at start: `[RALPLAN] Invoking Critic for plan review`

The Critic examines the plan against quality standards:

- Critic receives the plan file path (per its design)
- Critic conducts thorough review of plan completeness and feasibility
- Critic emits verdict: either `OKAY` (approval) or `REJECT` with specific issues

**Enforcement Rules:**
1. If Planner signals PLAN_READY, Critic MUST be invoked immediately
2. DO NOT exit ralplan loop before Critic verdict
3. DO NOT request user confirmation before Critic verdict
4. DO NOT trigger any plan mode exit behavior before Critic verdict

Log after Critic completes: `[RALPLAN] Critic verdict: <OKAY|REJECT>`

### Verdict Handling and Iteration

Based on Critic's verdict, the skill either proceeds to user approval or continues iteration:

**If verdict is OKAY:**
- Mark plan as approved by Critic
- Log approval with iteration count
- **Transition to `awaiting_user_approval` phase (MANDATORY - see User Approval Gate below)**
- **DO NOT create branches, spawn executors, or modify any code**

**If verdict is REJECT:**
- Extract Critic feedback with specific issues
- Increment iteration counter
- If `iteration >= max_iterations` (5):
  - Force approval with warning about unresolved concerns
  - **Still proceed to User Approval Gate** (user may choose not to execute)
- Otherwise:
  - Feed Critic feedback back to Planner
  - Return to Planner Planning phase for refinement

### User Approval Gate (MANDATORY - CANNOT BE SKIPPED)

**This is the HUMAN-IN-THE-LOOP checkpoint. After the Critic approves (or max iterations reached), the orchestrator MUST stop and present the plan to the user for explicit approval before ANY implementation begins.**

**HARD RULES:**
1. **NEVER** create git branches after Critic approval without user consent
2. **NEVER** spawn executor agents after Critic approval without user consent
3. **NEVER** modify source code after Critic approval without user consent
4. **NEVER** invoke `/oh-my-claudecode:ralph` or any execution mode without user consent
5. **ALWAYS** use `AskUserQuestion` tool to get explicit user decision
6. **ALWAYS** wait for user response before taking any action

**Update state:** Set `current_phase: "awaiting_user_approval"`

**Log:** `[RALPLAN] Plan approved by Critic. Awaiting user approval before implementation.`

**Present to user:**
1. Display a summary of the approved plan (path, scope, key deliverables, iteration count)
2. Use `AskUserQuestion` tool with the following options:

| Option | Label | Description |
|--------|-------|-------------|
| 1 | **Proceed** | Begin implementation with `/oh-my-claudecode:ralph` |
| 2 | **Adjust** | Return to Planner to modify specific aspects |
| 3 | **Discard** | Stop ralplan and discard the plan |

**Handle user response:**

| User Decision | Action |
|---------------|--------|
| **Proceed** | Set state `active: false, current_phase: "complete"`. Tell user to run `/oh-my-claudecode:ralph` with the plan path, OR invoke it if user explicitly requests |
| **Adjust** | Return to Planner Planning phase with user's adjustment feedback. Reset iteration if needed |
| **Discard** | Set state `active: false, current_phase: "cancelled"`. Log cancellation. Do NOT execute anything |
| **No response / Silence** | WAIT. Do NOT proceed. Do NOT assume consent |

## Iteration Rules

| Rule | Description |
|------|-------------|
| **Max 5 iterations** | Safety limit prevents infinite loops |
| **Planner owns plan** | Only Planner writes to plan file |
| **Architect provides wisdom** | Architect reads and advises, never modifies |
| **Critic has final say** | Plan approved only when Critic signals OKAY |
| **Feedback is specific** | Each rejection includes actionable improvements |
| **State persists** | Progress survives session interruptions |

## Quality Gates

The orchestrator must verify these gates before invoking Critic for each review:

1. **Plan file exists** at the path specified in state
2. **File references are valid** - Verify all mentioned files exist in codebase
3. **Acceptance criteria are concrete** - No vague "improve" or "optimize" without measurable metrics
4. **No ambiguous language** - Each task clearly specifies what to do

If any gate fails, return to Planner with specific failure feedback for remediation.

## Agent Communication Protocol

### Planner to Architect Questions

```
ARCHITECT_QUESTION:
- Topic: [Architecture/Performance/Security/Pattern]
- Context: [What we're planning]
- Files to examine: [specific paths]
- Specific Question: [What we need answered]
```

### Architect to Planner Answers

```
ARCHITECT_ANSWER:
- Topic: [Matching topic]
- Analysis: [What Architect found after reading files]
- Recommendation: [Specific guidance]
- Trade-offs: [What to consider]
- References: [file:line citations from codebase]
```

### Critic to Planner Feedback

```
CRITIC_FEEDBACK:
- Verdict: REJECT
- Critical Issues:
  1. [Issue with specific fix required]
  2. [Issue with specific fix required]
- Minor Issues:
  1. [Nice to fix]
- Questions for Architect (if any):
  1. [Architectural question needing expert input]
```

## Cancellation

To stop an active ralplan session:

- Use `/oh-my-claudecode:cancel` (automatically detects active mode)
- Or manually delete `.omc/ralplan-state.json`

## Skill Workflow

1. **Initialize state** and log: `[RALPLAN Iteration 0/5] Initializing...`
2. **Parse task** from user input
3. **Spawn Planner** in direct planning mode (SKIP Planner's PHASE 3.5 confirmation)
4. **Wait for PLAN_READY** signal from Planner
5. **Log:** `[RALPLAN] Critic review required before approval`
6. **Invoke Critic** with plan file path (MANDATORY - CANNOT BE SKIPPED)
7. **Log:** `[RALPLAN] Critic verdict: <verdict>`
8. **Handle verdict** - if REJECT, loop back to step 3 with feedback
9. **Present approved plan to user** using `AskUserQuestion` (MANDATORY - CANNOT BE SKIPPED)
10. **Log:** `[RALPLAN] Plan approved by Critic. Awaiting user approval before implementation.`
11. **STOP AND WAIT** for explicit user decision (Proceed / Adjust / Discard)
12. **Complete** ONLY after user explicitly approves

**HARD RULE 1:** Steps 5-7 are NON-NEGOTIABLE. No plan approval, user confirmation, or plan mode exit can occur before the Critic has rendered its verdict. This prevents the plan mode confirmation flow from short-circuiting the ralplan review loop.

**HARD RULE 2:** Steps 9-12 are NON-NEGOTIABLE. After the Critic approves, the orchestrator MUST present the plan to the user and WAIT for explicit consent before ANY implementation (branching, code execution, file modification). This is the human-in-the-loop safety gate that prevents unsolicited autonomous execution.

**FORBIDDEN after Critic OKAY without user consent:**
- `git checkout -b` (branch creation)
- `git branch` (branch creation)
- Spawning executor agents
- Invoking `/oh-my-claudecode:ralph` or any execution mode
- Writing to any source code files
- Any codebase mutation whatsoever

The iterative loop refines the plan until it meets the rigorous standards of all three agents. After consensus, the plan is presented to the user for final approval before any implementation begins.
