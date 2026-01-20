---
name: ralplan
description: Iterative planning with Planner, Architect, and Critic until consensus
---

[RALPLAN MODE - ITERATIVE CONSENSUS PLANNING]

$ARGUMENTS

## The Planning Triad

Ralplan orchestrates three specialized agents in an iterative loop until all are satisfied:

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
│    │           Ready for /ralph execution                     │ │
│    └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## State Tracking

Ralplan maintains state in `.omc/ralplan-state.json`:

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

**Phases**: `planner_planning` → `architect_consultation` → `critic_review` → `handling_verdict` → `complete`

## Execution Protocol

### Step 1: Initialize

```
[RALPLAN Iteration 0/5] Initializing...

1. Create .omc/plans/ if not exists
2. Read task description from $ARGUMENTS
3. Create ralplan-state.json:
   - active: true
   - iteration: 0
   - max_iterations: 5
   - current_phase: "planner_planning"
   - started_at: [ISO timestamp]
   - task_description: [from arguments]
```

### Step 2: Planner Planning Phase

```
[RALPLAN Iteration 1/5] Planner creating plan...
```

Spawn Planner in **direct planning mode** (bypassing interview since task context is pre-gathered):

```
Task(subagent_type="oh-my-claudecode:planner", model="opus", prompt="
RALPLAN DIRECT MODE - Create work plan immediately.

TASK CONTEXT: [User's task description from $ARGUMENTS]

You are being invoked by ralplan in direct mode. This means:
1. The user has already provided the task context above
2. Skip the interview phase - context is already gathered
3. Consult with Metis for gaps (MANDATORY)
4. Generate plan directly to .omc/plans/[feature-name].md

PLAN REQUIREMENTS:
- Clear requirements summary
- Concrete acceptance criteria
- Specific implementation steps with file references
- Risk identification and mitigations
- Verification steps

Signal completion: 'PLAN_READY: .omc/plans/[filename].md'
")
```

**Note**: The `PLAN_READY:` signal is a ralplan integration convention. Planner will emit this signal
when instructed via the Task prompt above, allowing the orchestrator to detect plan completion and extract
the plan file path for subsequent steps.

Update state: `plan_path: [extracted from PLAN_READY signal]`

### Step 3: Architect Consultation (Conditional)

Architect is invoked in TWO scenarios:
1. **After Planner**: If Planner raises architectural questions needing strategic input
2. **After Critic rejection**: If Critic identifies questions that need expert guidance

```
[RALPLAN Iteration 1/5] Architect consultation requested...
```

When invoked, give Architect **file paths to read**, not summaries:

```
Task(subagent_type="oh-my-claudecode:architect", model="opus", prompt="
RALPLAN ARCHITECT CONSULTATION

PLAN FILE: .omc/plans/[filename].md
CODEBASE ROOT: [working directory]

QUESTIONS REQUIRING STRATEGIC GUIDANCE:
[List specific questions from Planner or Critic]

Your task:
1. Read the plan file above
2. Explore relevant codebase files as needed
3. Provide strategic guidance on the questions

Format answers using ARCHITECT_ANSWER protocol (see below).
")
```

Update state: `current_phase: "architect_consultation"`

### Step 4: Critic Review

```
[RALPLAN Iteration 1/5] Critic reviewing plan...
```

Critic receives only the file path (per its design):

```
Task(subagent_type="oh-my-claudecode:critic", model="opus", prompt="
.omc/plans/[filename].md
")
```

Update state: `current_phase: "critic_review"`

### Step 5: Handle Verdict and Complete

```
[RALPLAN Iteration 1/5] Processing Critic verdict...
```

Update state: `current_phase: "handling_verdict"`

**IF verdict == "OKAY":**
```
[RALPLAN] APPROVED after [N] iterations

<ralplan-complete>
PLAN APPROVED BY ALL AGENTS

Plan Location: .omc/plans/[filename].md
Iterations: [count]

Ready for execution with:
  /ralph [task description]

Or manual execution with:
  /sisyphus .omc/plans/[filename].md
</ralplan-complete>
```

Update state: `active: false, current_phase: "complete"`

**IF verdict == "REJECT":**
```
[RALPLAN Iteration 1/5] REJECTED - [N] issues found

Extract Critic feedback...
Increment iteration to [N+1]
```

- Increment `iteration` in state
- IF `iteration >= max_iterations`:
  ```
  [RALPLAN] Max iterations (5) reached. Forcing approval with warnings.

  WARNING: Plan approved by force after 5 iterations.
  Critic's final concerns:
  [List unresolved issues]

  Proceed with caution. Consider manual review before execution.
  ```
- ELSE:
  - Feed Critic feedback back to Planner
  - Return to Step 2

## Iteration Rules

| Rule | Description |
|------|-------------|
| **Max 5 iterations** | Safety limit to prevent infinite loops |
| **Planner owns the plan** | Only Planner writes to the plan file |
| **Architect provides wisdom** | Architect reads and advises, never modifies |
| **Critic has final say** | Plan is not done until Critic says OKAY |
| **Feedback is specific** | Each rejection must include actionable items |
| **State is persistent** | Progress survives session interruptions |

## Quality Gates

**Enforcement**: The orchestrator (you, Claude) MUST verify these gates BEFORE invoking Critic.

Before each Critic review:

1. **Plan file exists** at `plan_path` in state
2. **File references are valid** - Use Glob to verify files mentioned in plan exist
3. **Acceptance criteria are concrete** - No vague "improve" or "optimize" without metrics
4. **No ambiguous language** - Each task should specify exactly what to do

**If any gate fails:**
```
[RALPLAN] QUALITY GATE FAILURE

Gate: [which gate failed]
Issue: [specific problem]

Returning to Planner with feedback...
```

Then return to Step 2 (Planner) with the specific failure as feedback.

## Agent Communication Protocol

### Planner → Architect Questions
```
ARCHITECT_QUESTION:
- Topic: [Architecture/Performance/Security/Pattern]
- Context: [What we're planning]
- Files to examine: [specific paths]
- Specific Question: [What we need answered]
```

### Architect → Planner Answers
```
ARCHITECT_ANSWER:
- Topic: [Matching topic]
- Analysis: [What Architect found after reading files]
- Recommendation: [Specific guidance]
- Trade-offs: [What to consider]
- References: [file:line citations from codebase]
```

### Critic → Planner Feedback
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

To cancel ralplan:
- Use `/cancel-ralph` (detects ralplan via state file)
- Or manually delete `.omc/ralplan-state.json`

## Begin Now

1. **Initialize state** and log: `[RALPLAN Iteration 0/5] Initializing...`
2. **Parse the task** from $ARGUMENTS
3. **Spawn Planner** in direct planning mode
4. **Iterate** through the planning loop with observability logging
5. **Complete** when Critic approves (or max iterations with warning)

The loop will refine the plan until it meets the rigorous standards of all three agents.
