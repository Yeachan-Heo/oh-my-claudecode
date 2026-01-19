---
description: Iterative planning with Prometheus, Oracle, and Momus until consensus
---

[RALPH-PLAN MODE - ITERATIVE CONSENSUS PLANNING]

$ARGUMENTS

## The Planning Triad

Ralph-Plan orchestrates three specialized agents in an iterative loop until all are satisfied:

| Agent | Role | Output |
|-------|------|--------|
| **Prometheus** | Strategic Planner | Creates/refines the work plan |
| **Oracle** | Strategic Advisor | Answers questions, validates architecture |
| **Momus** | Ruthless Reviewer | Critiques and identifies gaps |

## The Iteration Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                      RALPH-PLAN LOOP                            │
│                                                                 │
│    ┌──────────────┐                                             │
│    │  PROMETHEUS  │◄────────────────────────────────┐           │
│    │   (Plans)    │                                 │           │
│    └──────┬───────┘                                 │           │
│           │                                         │           │
│           ▼                                         │           │
│    ┌──────────────┐     Questions?    ┌─────────┐   │           │
│    │   Has open   │─────────────────► │ ORACLE  │   │           │
│    │  questions?  │                   │(Advises)│   │           │
│    └──────┬───────┘                   └────┬────┘   │           │
│           │                                │        │           │
│           │ No questions                   │        │           │
│           ▼                                ▼        │           │
│    ┌──────────────┐                  ┌──────────┐   │           │
│    │    MOMUS     │◄─────────────────│ Answers  │   │           │
│    │  (Reviews)   │                  └──────────┘   │           │
│    └──────┬───────┘                                 │           │
│           │                                         │           │
│           ▼                                         │           │
│    ┌──────────────┐     REJECT      ┌──────────────┐│           │
│    │   Verdict?   │─────────────────►│  Feedback   ││           │
│    └──────┬───────┘                  │  to Prom.   │┘           │
│           │                          └─────────────┘            │
│           │ OKAY                                                │
│           ▼                                                     │
│    ┌──────────────────────────────────────────────────────────┐ │
│    │                  PLAN APPROVED                           │ │
│    │           Ready for /ralph-loop execution                │ │
│    └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## State Tracking

Ralph-plan maintains state in `.sisyphus/ralph-plan-state.json`:

```json
{
  "active": true,
  "mode": "ralph-plan",
  "iteration": 1,
  "max_iterations": 5,
  "plan_path": ".sisyphus/plans/[feature].md",
  "current_phase": "prometheus_planning",
  "started_at": "ISO-timestamp",
  "task_description": "[original task]"
}
```

**Phases**: `prometheus_planning` → `oracle_consultation` → `momus_review` → `handling_verdict` → `complete`

## Execution Protocol

### Step 1: Initialize

```
[RALPH-PLAN Iteration 0/5] Initializing...

1. Create .sisyphus/plans/ if not exists
2. Read task description from $ARGUMENTS
3. Create ralph-plan-state.json:
   - active: true
   - iteration: 0
   - max_iterations: 5
   - current_phase: "prometheus_planning"
   - started_at: [ISO timestamp]
   - task_description: [from arguments]
```

### Step 2: Prometheus Planning Phase

```
[RALPH-PLAN Iteration 1/5] Prometheus creating plan...
```

Spawn Prometheus in **direct planning mode** (bypassing interview since task context is pre-gathered):

```
Task(subagent_type="oh-my-claude-sisyphus:prometheus", prompt="
RALPH-PLAN DIRECT MODE - Create work plan immediately.

TASK CONTEXT: [User's task description from $ARGUMENTS]

You are being invoked by ralph-plan in direct mode. This means:
1. The user has already provided the task context above
2. Skip the interview phase - context is already gathered
3. Consult with Metis for gaps (MANDATORY)
4. Generate plan directly to .sisyphus/plans/[feature-name].md

PLAN REQUIREMENTS:
- Clear requirements summary
- Concrete acceptance criteria
- Specific implementation steps with file references
- Risk identification and mitigations
- Verification steps

Signal completion: 'PLAN_READY: .sisyphus/plans/[filename].md'
")
```

**Note**: The `PLAN_READY:` signal is a ralph-plan integration convention. Prometheus will emit this signal
when instructed via the Task prompt above, allowing the orchestrator to detect plan completion and extract
the plan file path for subsequent steps.

Update state: `plan_path: [extracted from PLAN_READY signal]`

### Step 3: Oracle Consultation (Conditional)

Oracle is invoked in TWO scenarios:
1. **After Prometheus**: If Prometheus raises architectural questions needing strategic input
2. **After Momus rejection**: If Momus identifies questions that need expert guidance

```
[RALPH-PLAN Iteration 1/5] Oracle consultation requested...
```

When invoked, give Oracle **file paths to read**, not summaries:

```
Task(subagent_type="oh-my-claude-sisyphus:oracle", prompt="
RALPH-PLAN ORACLE CONSULTATION

PLAN FILE: .sisyphus/plans/[filename].md
CODEBASE ROOT: [working directory]

QUESTIONS REQUIRING STRATEGIC GUIDANCE:
[List specific questions from Prometheus or Momus]

Your task:
1. Read the plan file above
2. Explore relevant codebase files as needed
3. Provide strategic guidance on the questions

Format answers using ORACLE_ANSWER protocol (see below).
")
```

Update state: `current_phase: "oracle_consultation"`

### Step 4: Momus Review

```
[RALPH-PLAN Iteration 1/5] Momus reviewing plan...
```

Momus receives only the file path (per its design):

```
Task(subagent_type="oh-my-claude-sisyphus:momus", prompt="
.sisyphus/plans/[filename].md
")
```

Update state: `current_phase: "momus_review"`

### Step 5: Handle Verdict and Complete

```
[RALPH-PLAN Iteration 1/5] Processing Momus verdict...
```

Update state: `current_phase: "handling_verdict"`

**IF verdict == "OKAY":**
```
[RALPH-PLAN] APPROVED after [N] iterations

<ralph-plan-complete>
PLAN APPROVED BY ALL AGENTS

Plan Location: .sisyphus/plans/[filename].md
Iterations: [count]

Ready for execution with:
  /ralph-loop [task description]

Or manual execution with:
  /sisyphus .sisyphus/plans/[filename].md
</ralph-plan-complete>
```

Update state: `active: false, current_phase: "complete"`

**IF verdict == "REJECT":**
```
[RALPH-PLAN Iteration 1/5] REJECTED - [N] issues found

Extract Momus feedback...
Increment iteration to [N+1]
```

- Increment `iteration` in state
- IF `iteration >= max_iterations`:
  ```
  [RALPH-PLAN] Max iterations (5) reached. Forcing approval with warnings.

  WARNING: Plan approved by force after 5 iterations.
  Momus's final concerns:
  [List unresolved issues]

  Proceed with caution. Consider manual review before execution.
  ```
- ELSE:
  - Feed Momus feedback back to Prometheus
  - Return to Step 2

## Iteration Rules

| Rule | Description |
|------|-------------|
| **Max 5 iterations** | Safety limit to prevent infinite loops |
| **Prometheus owns the plan** | Only Prometheus writes to the plan file |
| **Oracle provides wisdom** | Oracle reads and advises, never modifies |
| **Momus has final say** | Plan is not done until Momus says OKAY |
| **Feedback is specific** | Each rejection must include actionable items |
| **State is persistent** | Progress survives session interruptions |

## Quality Gates

**Enforcement**: The orchestrator (you, Claude) MUST verify these gates BEFORE invoking Momus.

Before each Momus review:

1. **Plan file exists** at `plan_path` in state
2. **File references are valid** - Use Glob to verify files mentioned in plan exist
3. **Acceptance criteria are concrete** - No vague "improve" or "optimize" without metrics
4. **No ambiguous language** - Each task should specify exactly what to do

**If any gate fails:**
```
[RALPH-PLAN] QUALITY GATE FAILURE

Gate: [which gate failed]
Issue: [specific problem]

Returning to Prometheus with feedback...
```

Then return to Step 2 (Prometheus) with the specific failure as feedback.

## Agent Communication Protocol

### Prometheus → Oracle Questions
```
ORACLE_QUESTION:
- Topic: [Architecture/Performance/Security/Pattern]
- Context: [What we're planning]
- Files to examine: [specific paths]
- Specific Question: [What we need answered]
```

### Oracle → Prometheus Answers
```
ORACLE_ANSWER:
- Topic: [Matching topic]
- Analysis: [What Oracle found after reading files]
- Recommendation: [Specific guidance]
- Trade-offs: [What to consider]
- References: [file:line citations from codebase]
```

### Momus → Prometheus Feedback
```
MOMUS_FEEDBACK:
- Verdict: REJECT
- Critical Issues:
  1. [Issue with specific fix required]
  2. [Issue with specific fix required]
- Minor Issues:
  1. [Nice to fix]
- Questions for Oracle (if any):
  1. [Architectural question needing expert input]
```

## Cancellation

To cancel ralph-plan:
- Use `/cancel-ralph` (detects ralph-plan via state file)
- Or manually delete `.sisyphus/ralph-plan-state.json`

## Begin Now

1. **Initialize state** and log: `[RALPH-PLAN Iteration 0/5] Initializing...`
2. **Parse the task** from $ARGUMENTS
3. **Spawn Prometheus** in direct planning mode
4. **Iterate** through the planning loop with observability logging
5. **Complete** when Momus approves (or max iterations with warning)

The loop will refine the plan until it meets the rigorous standards of all three agents.
