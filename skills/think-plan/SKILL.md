---
name: think-plan
description: Activate extended thinking for deep reasoning, use plan mode for structured execution, and combine think+plan for complex tasks
level: 2
aliases: [think, thinking, deep-think, think-mode]
argument-hint: [think|plan|combo|guide] - default is guide
---

# Think & Plan Skill

Master Claude Code's extended thinking and plan mode for complex software tasks. Learn when to use each mode and how to combine them for maximum effectiveness.

## Usage

```
/oh-my-claudecode:think-plan
/oh-my-claudecode:think-plan think
/oh-my-claudecode:think-plan plan
/oh-my-claudecode:think-plan combo
/oh-my-claudecode:think-plan guide
```

Or say: "think deeply about this", "plan mode", "think and plan", "extended thinking"

## Modes

| Mode | What It Does | Best For |
|------|-------------|----------|
| `guide` | Explain all modes and when to use each | Learning |
| `think` | Activate extended thinking prompts | Complex reasoning |
| `plan` | Activate structured plan mode | Multi-step execution |
| `combo` | Think first, then plan | Most complex tasks |

## When to Use What

```
                  Simple task?
                 /           \
               YES            NO
              /                 \
         Just do it         Complex reasoning needed?
                           /           \
                         YES            NO
                        /                 \
                   THINK MODE         Multi-step execution?
                   (deep reasoning)   /           \
                                    YES            NO
                                   /                 \
                              PLAN MODE          Standard mode
                              (structured steps)  (just work on it)

         Both complex reasoning AND multi-step?
                        → THINK + PLAN COMBO
```

### Decision Matrix

| Task Type | Mode | Example |
|-----------|------|---------|
| Quick fix | Standard | Fix a typo, add a log statement |
| Bug investigation | **Think** | "Why does this race condition happen?" |
| Feature implementation | **Plan** | "Add user authentication with OAuth" |
| Architecture design | **Think + Plan** | "Redesign the database schema for multi-tenancy" |
| Complex debugging | **Think** | "Why does memory leak only in production?" |
| Large refactor | **Plan** | "Migrate from REST to GraphQL" |
| System design | **Think + Plan** | "Design a real-time notification system" |
| Performance optimization | **Think** | "Why is this query slow?" then **Plan** to fix |
| Security review | **Think** | "What are the attack vectors?" |
| Migration planning | **Think + Plan** | "Plan migration from monolith to microservices" |

## Workflow

### Mode: Think (Extended Thinking)

Extended thinking makes Claude reason more deeply before responding. Use it for problems where the first answer might be wrong.

#### Activating Think Mode

**Method 1: Explicit prompt**
```
Think step by step about this problem before responding:
{your complex question}
```

**Method 2: Using ultrathink keyword**
Say "ultrathink" to activate deep reasoning mode (OMC keyword trigger).

**Method 3: Using /effort**
```
/effort max
```
This sets the thinking effort to maximum for the session.

#### Best Prompts for Think Mode

**For debugging:**
```
Think carefully about what could cause this behavior:

Error: {error message}
Context: {what was happening}
Recent changes: {what changed}

Consider at least 3 possible root causes, evaluate each against the evidence, then identify the most likely one.
```

**For architecture:**
```
Think deeply about the architecture for this feature:

Requirements: {what it needs to do}
Constraints: {performance, compatibility, scale}
Existing patterns: {what the codebase already uses}

Consider tradeoffs between at least 2 approaches before recommending one.
```

**For security:**
```
Think from an attacker's perspective:

Feature: {what you're building}
Data: {what sensitive data is involved}
Access: {who can access this}

What are the attack vectors? What could go wrong?
```

#### Think Mode Anti-Patterns

| Don't Do This | Do This Instead |
|---------------|----------------|
| "Think about everything" | "Think about {specific aspect}" |
| Use think for simple lookups | Use standard mode for factual queries |
| Chain multiple think prompts | One focused think prompt, then act |
| Think without constraints | Provide context and constraints |

### Mode: Plan (Structured Execution)

Plan mode creates a structured execution plan before writing code. Use it when a task has multiple steps that need coordination.

#### Activating Plan Mode

**Method 1: Use OMC plan skill**
```
/oh-my-claudecode:plan
```
This activates the full OMC planning workflow with consensus mode.

**Method 2: Use EnterPlanMode tool**
Claude will enter plan mode when appropriate for complex tasks.

**Method 3: Explicit prompt**
```
Before coding, create a step-by-step plan for:
{your multi-step task}

For each step, include:
- What to do
- Which files to modify
- Acceptance criteria
- Estimated complexity

Wait for my approval before implementing.
```

#### Plan Mode Best Practices

1. **Break down by file/concern**, not by time
2. **Include acceptance criteria** for each step — how do you know it's done?
3. **Order by dependency** — what must come first?
4. **Identify parallelizable steps** — what can be done simultaneously?
5. **Flag risks** — which steps might fail or need iteration?

#### Plan Output Template

```markdown
## Plan: {task name}

### Step 1: {action}
- Files: {list}
- Changes: {description}
- Acceptance: {testable criteria}
- Risk: {low|medium|high}

### Step 2: {action}
...

### Verification
- Run: {test command}
- Check: {what to verify}
- Rollback: {how to undo if wrong}
```

### Mode: Combo (Think + Plan)

The most powerful workflow for complex tasks. Think first to understand the problem deeply, then plan the solution.

#### Combo Workflow

```
Step 1: THINK — Understand the problem
  "Think deeply about {problem}. Consider constraints, edge cases,
   and at least 2 approaches with tradeoffs."

Step 2: DECIDE — Choose an approach
  Review Claude's analysis, ask clarifying questions,
  select the best approach.

Step 3: PLAN — Create execution plan
  "Based on approach {X}, create a step-by-step implementation plan
   with acceptance criteria for each step."

Step 4: REVIEW — Approve the plan
  Review the plan, adjust if needed.

Step 5: EXECUTE — Implement the plan
  Follow the plan step by step, verifying each step passes
  before moving to the next.
```

#### Example: Database Schema Redesign

```
THINK: "Think about how to redesign our user table to support multi-tenancy.
  Current schema: {description}
  Constraints: Zero-downtime migration, backwards compatible API
  Consider: Row-level isolation vs schema-per-tenant vs database-per-tenant"

[Claude thinks deeply, presents tradeoffs]

DECIDE: "Go with row-level isolation using tenant_id column"

PLAN: "Create a migration plan for adding multi-tenancy with row-level isolation:
  1. Schema changes needed
  2. Data migration steps
  3. Application code changes
  4. API backwards compatibility
  5. Testing plan
  6. Rollback strategy"

[Claude creates detailed plan]

EXECUTE: Follow the plan, step by step.
```

## OMC Integration

| OMC Feature | Think/Plan Connection |
|-------------|----------------------|
| `/ralplan` | Consensus planning = think+plan with architect+planner+critic |
| `/deep-interview` | Socratic thinking before planning |
| `/autopilot` | Phase 0 (think) → Phase 1 (plan) → Phase 2+ (execute) |
| `/trace` | Think mode for root cause analysis |
| `/oh-my-claudecode:plan` | Full planning workflow with multiple modes |

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Guide displayed** | Show decision matrix and mode explanations |
| **Think activated** | Deep reasoning prompt delivered |
| **Plan created** | Structured plan ready for review |
| **Combo initiated** | Think phase started, plan to follow |

## Notes

- **Think is not always better**: For simple, clear tasks, thinking slows things down without improving quality.
- **Plan saves time overall**: Planning seems slower but prevents costly rework on complex tasks.
- **Combo for high-stakes**: Use combo when the cost of getting it wrong is high (production systems, architecture, security).
- **Session state matters**: Think mode uses more tokens. Monitor context usage on long sessions.
- **Complements /effort**: Use `/effort max` for persistent think activation across the session.

---

Begin think-plan guidance now. Parse the mode and provide the appropriate guidance or activate the requested mode.
