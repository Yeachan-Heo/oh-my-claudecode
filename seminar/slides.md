---
title: Oh-My-ClaudeCode
subtitle: Multi-Agent Orchestration for Autonomous Development
author: Yeachan Heo
theme: night
---

# Oh-My-ClaudeCode

**Multi-Agent Orchestration for Autonomous Development**

---

# 🎭 Let's Start with a LIVE Demo

**You tell me what to build, I'll build it in 10 minutes.**

What do you need?
- Todo app?
- Weather dashboard?
- Real-time poll?
- Mini game?

*Drop your idea in the chat!*

---
# oh-my-claudecode: Multi-Agent Orchestration for Claude Code

## Zero learning curve. Maximum power.

**[Speaker Name]**

Version 3.6.3

---

## Agenda

| Time | Topic |
|------|-------|
| 0:00 | What is OMC? |
| 0:10 | The 5 Key Execution Modes |
| 0:30 | The Agent System |
| 0:40 | Live Demo Scenarios |
| 0:48 | Developer Experience |
| 0:54 | Getting Started |
| 0:58 | Q&A |

Note: This is a 60-minute seminar covering the complete oh-my-claudecode system. We'll focus on practical usage patterns.

---

## The Problem

**Developers today face:**

- Manual coordination of complex multi-step tasks <!-- .element: class="fragment" -->
- Constant context-switching between different concerns <!-- .element: class="fragment" -->
- Single-threaded AI interactions that don't scale <!-- .element: class="fragment" -->
- No persistence - AI gives up when tasks get hard <!-- .element: class="fragment" -->
- Token waste - using expensive models for simple tasks <!-- .element: class="fragment" -->

Note: These are real problems I faced building production applications with Claude Code. OMC was born from frustration with manually orchestrating AI-assisted development.

---
<!-- .slide: data-background="#1a1a2e" -->

# Section 1
## What is OMC?

---

## What is oh-my-claudecode?

**A multi-agent orchestration system for Claude Code**

```
                    +------------------+
                    |     You (User)   |
                    +--------+---------+
                             |
                             v
                    +------------------+
                    |  Claude (Conductor)  |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
              v              v              v
        +---------+    +---------+    +---------+
        | Skill 1 |    | Skill 2 |    | Skill N |
        +---------+    +---------+    +---------+
              |              |              |
              v              v              v
        +---------+    +---------+    +---------+
        | Agent A |    | Agent B |    | Agent C |
        +---------+    +---------+    +---------+
```

- 28 specialized agents <!-- .element: class="fragment" -->
- 37 skills <!-- .element: class="fragment" -->
- Zero configuration required <!-- .element: class="fragment" -->

Note: OMC transforms Claude from a single performer into a conductor of an orchestra of specialized AI agents.

---

## The Philosophy

> "You are a CONDUCTOR, not a performer."

**Traditional AI Workflow:**
```
User -> Claude -> [Does everything itself]
```

**OMC Workflow:**
```
User -> Claude (Conductor) -> [Delegates to specialists]
                                    |
                    +---------------+---------------+
                    |               |               |
               architect       executor        designer
              (analysis)   (implementation)   (UI/UX)
```

**Claude becomes an intelligent orchestrator** that delegates to the right specialist for each task.

Note: This is the core mental model. Claude stops being a generalist trying to do everything and becomes a smart coordinator.

---

## Before vs After OMC

| Aspect | Before OMC | After OMC |
|--------|-----------|-----------|
| **Task execution** | Single-threaded | Parallel agents |
| **Complex tasks** | Manual breakdown | Automatic decomposition |
| **Model selection** | Always same model | Smart routing (Haiku/Sonnet/Opus) |
| **Persistence** | Gives up easily | Continues until verified |
| **Cost** | Expensive | 30-50% savings |
| **Learning curve** | Command memorization | Natural language |

**Example - "Fix all TypeScript errors":**

Before: You manually find and fix each error sequentially

After: 5 parallel agents claim and fix errors simultaneously

Note: The cost savings come from using Haiku ($0.25/1M tokens) for simple tasks instead of Opus ($15/1M tokens).

---

## Key Statistics

| Metric | Value |
|--------|-------|
| Specialized Agents | 32 |
| Skills | 35+ |
| Execution Modes | 8 |
| Lifecycle Hooks | 19 |
| Model Tiers | 3 (Haiku, Sonnet, Opus) |
| License | MIT |

**Token Cost Comparison:**

| Model | Input | Output |
|-------|-------|--------|
| Haiku | $0.25/1M | $1.25/1M |
| Sonnet | $3/1M | $15/1M |
| Opus | $15/1M | $75/1M |

Note: Smart model routing means using the cheapest model that can handle the task.

---

## Architecture Overview

```
+--------------------------------------------------------------------+
|                           USER INPUT                                |
|                    "autopilot: build a REST API"                    |
+------------------------------------+-------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------+
|                      CLAUDE CODE (CONDUCTOR)                        |
|  +----------------+  +----------------+  +---------------------+    |
|  | Keyword        |  | Skill          |  | Agent               |    |
|  | Detection      |->| Resolution     |->| Delegation          |    |
|  +----------------+  +----------------+  +---------------------+    |
+------------------------------------+-------------------------------+
                                     |
              +----------------------+----------------------+
              |                      |                      |
              v                      v                      v
     +---------------+      +---------------+      +---------------+
     | SKILL LAYER   |      | SKILL LAYER   |      | SKILL LAYER   |
     | autopilot     |      | ultrawork     |      | ralph         |
     +-------+-------+      +-------+-------+      +-------+-------+
             |                      |                      |
             v                      v                      v
     +---------------+      +---------------+      +---------------+
     | AGENT LAYER   |      | AGENT LAYER   |      | AGENT LAYER   |
     | analyst       |      | executor      |      | architect     |
     | architect     |      | executor-low  |      | critic        |
     | executor      |      | build-fixer   |      | executor      |
     +---------------+      +---------------+      +---------------+
```

Note: The architecture has three layers - keywords trigger skills, skills coordinate agents, agents do the actual work.

---
<!-- .slide: data-background="#1a1a2e" -->

# Section 2
## The 5 Key Execution Modes

---

## Mode 1: Autopilot - What Is It?

**Full autonomous execution from idea to working code**

```
"autopilot: build a REST API for a bookstore"
```

**5 Phases:**

1. **Expansion** - Turn vague idea into detailed spec
2. **Planning** - Create implementation plan with validation
3. **Execution** - Build with parallel agents (Ralph + Ultrawork)
4. **QA** - Test until everything passes (up to 5 cycles)
5. **Validation** - Multi-reviewer approval (Architect + Security + Code Review)

Note: Autopilot is the flagship experience. Give it an idea, walk away, come back to working code.

---

## Mode 1: Autopilot - How It Works

```
Phase 0: EXPANSION
    |
    +-> Analyst (Opus) extracts requirements
    +-> Architect (Opus) creates technical spec
    |
    v
Phase 1: PLANNING
    |
    +-> Architect creates plan (direct mode)
    +-> Critic validates plan
    |
    v
Phase 2: EXECUTION
    |
    +-> Ralph + Ultrawork activated
    +-> Executor-low (simple tasks)
    +-> Executor (standard tasks)
    +-> Executor-high (complex tasks)
    |
    v
Phase 3: QA (max 5 cycles)
    |
    +-> Build -> Lint -> Test -> Fix
    |
    v
Phase 4: VALIDATION
    |
    +-> Architect (functional completeness)
    +-> Security-reviewer (vulnerability check)
    +-> Code-reviewer (quality review)
```

Note: Each phase has clear entry and exit criteria. Autopilot won't move forward until the phase is verified complete.

---

## Mode 1: Autopilot - When To Use It

**Best For:**
- New projects from scratch
- Complete feature implementations
- End-to-end workflows

**Trigger Keywords:**
```
autopilot, auto pilot, autonomous
build me, create me, make me
full auto, handle it all
I want a/an...
```

**Example Commands:**
```
autopilot: build a REST API with CRUD for inventory

/oh-my-claudecode:autopilot Add OAuth2 authentication

autopilot: create a CLI tool that tracks daily habits
```

Note: Autopilot combines all the best capabilities - planning, persistence, parallelism, and validation.

---

## Mode 2: Ultrapilot - What Is It?

**Parallel autopilot with up to 5 concurrent workers**

3-5x faster than standard autopilot for suitable tasks.

```
"ultrapilot: build a full-stack todo app"
```

**Key Innovation:** File ownership partitioning

- Each worker gets exclusive file sets
- No conflicts between workers
- Shared files handled by coordinator

Note: Ultrapilot is for when you need autopilot-level autonomy but want maximum speed through parallelization.

---

## Mode 2: Ultrapilot - How It Works

```
User Input: "Build a full-stack todo app"
                    |
                    v
          [ULTRAPILOT COORDINATOR]
                    |
        Task Decomposition + File Partitioning
                    |
        +-----------+-----------+-----------+-----------+
        |           |           |           |           |
        v           v           v           v           v
    [Worker-1]  [Worker-2]  [Worker-3]  [Worker-4]  [Worker-5]
     backend     frontend    database    api-docs     tests
    (src/api/)  (src/ui/)   (src/db/)   (docs/)    (tests/)
        |           |           |           |           |
        +-----------+-----------+-----------+-----------+
                              |
                              v
                   [INTEGRATION PHASE]
           (shared files: package.json, tsconfig.json)
                              |
                              v
                   [VALIDATION PHASE]
                    (full system test)
```

Note: The decomposition phase is critical - it uses the Architect agent to identify parallel-safe subtasks.

---

## Mode 2: Ultrapilot - When To Use It

**Best For:**
- Multi-component systems (frontend + backend + database)
- Large refactorings with clear module boundaries
- Multi-service architectures
- Parallel test generation

**Speed Comparison:**

| Task | Autopilot | Ultrapilot |
|------|-----------|------------|
| Full-stack app | ~75 min | ~15 min |
| Multi-service refactor | ~32 min | ~8 min |
| Test coverage | ~50 min | ~10 min |

**Trigger:**
```
ultrapilot, parallel build, swarm build
```

Note: If your task has 3+ independent components, ultrapilot will likely be faster than autopilot.

---

## Mode 3: Swarm - What Is It?

**N coordinated agents with atomic task claiming**

```
/swarm 5:executor "fix all TypeScript errors"
```

**Architecture:**
- SQLite-based task pool
- Atomic claiming via transactions
- 5-minute lease timeout with auto-release
- Heartbeat monitoring for fault tolerance

Note: Swarm is like having a team of developers tackling a shared task list. Anyone can grab the next task.

---

## Mode 3: Swarm - How It Works

```
/swarm 5:executor "fix all TypeScript errors"
              |
              v
      [SWARM ORCHESTRATOR]
              |
   +--+--+--+--+--+
   |  |  |  |  |
   v  v  v  v  v
  E1 E2 E3 E4 E5    <-- 5 Executor agents
   |  |  |  |  |
   +--+--+--+--+
          |
          v
    [SQLITE DATABASE]
    +---------------------+
    | tasks table         |
    |---------------------|
    | id, description     |
    | status: pending,    |
    |   claimed, done,    |
    |   failed            |
    | claimed_by          |
    | heartbeat tracking  |
    +---------------------+
```

**Claim Protocol:**
1. Agent calls `claimTask()`
2. SQLite transaction atomically updates status
3. Agent works on task
4. Agent calls `completeTask()` or `failTask()`

Note: SQLite transactions guarantee no two agents can claim the same task - true atomicity.

---

## Mode 3: Swarm - When To Use It

**Best For:**
- Many independent parallel tasks
- File-by-file operations
- Batch processing

**Use Cases:**

```bash
# Fix all TypeScript errors
/swarm 5:executor "fix all TypeScript errors"

# Style all UI components
/swarm 3:designer "implement Material-UI styling for all components"

# Security audit all endpoints
/swarm 4:security-reviewer "review all API endpoints"

# Add documentation
/swarm 2:writer "add JSDoc comments to all exported functions"
```

Note: Swarm excels when you have many independent tasks that don't depend on each other.

---

## Mode 4: Pipeline - What Is It?

**Sequential agent chaining with data passing**

Like Unix pipes, but for AI agents.

```
/pipeline explore -> architect -> executor "add authentication"
```

**Output of one agent becomes input to the next:**

```
[explore findings] -> [architect analysis] -> [executor implementation]
```

Note: Pipeline is for workflows that must happen in a specific order, where each step needs context from the previous.

---

## Mode 4: Pipeline - Built-in Presets

| Preset | Stages | Use For |
|--------|--------|---------|
| `review` | explore -> architect -> critic -> executor | Major features, refactorings |
| `implement` | planner -> executor -> tdd-guide | New features with tests |
| `debug` | explore -> architect -> build-fixer | Bugs, build errors |
| `research` | parallel(researcher, explore) -> architect -> writer | Technology decisions |
| `refactor` | explore -> architect-medium -> executor-high -> qa-tester | Safe refactoring |
| `security` | explore -> security-reviewer -> executor -> security-reviewer-low | Security fixes |

**Usage:**
```
/pipeline review "add rate limiting to API"
/pipeline debug "login fails with OAuth"
/pipeline security "audit user authentication"
```

Note: These presets encode best practices for common workflows. Start here before creating custom pipelines.

---

## Mode 4: Pipeline - When To Use It

**Best For:**
- Multi-stage processing workflows
- Code review processes
- Research-to-implementation flows

**Custom Pipeline Syntax:**

```
# Basic sequential
/pipeline agent1 -> agent2 -> agent3 "task"

# With model specification
/pipeline explore:haiku -> architect:opus -> executor:sonnet "task"

# With parallel stages
/pipeline [explore, researcher] -> architect -> executor "task"
```

**Data Flow:**
```json
{
  "pipeline_context": {
    "original_task": "user's request",
    "previous_stages": [
      {"agent": "explore", "findings": "..."}
    ],
    "current_stage": "architect"
  }
}
```

Note: The data passing protocol ensures each agent has full context from previous stages.

---

## Mode 5: Ecomode - What Is It?

**Token-efficient parallel execution**

30-50% cheaper than standard execution.

```
eco: implement new feature
```

**Strategy:**
- Prefer Haiku (cheapest) for all tasks
- Only upgrade to Sonnet when needed
- Avoid Opus unless absolutely essential

Note: Ecomode is for budget-conscious development or exploratory work where you want to minimize costs.

---

## Mode 5: Ecomode - How It Works

**Routing Rules:**

| Task Type | Standard Mode | Ecomode |
|-----------|---------------|---------|
| Simple lookup | architect-low | architect-low |
| Standard impl | executor | executor-low (first attempt) |
| Complex analysis | architect | architect-medium |
| Planning | planner (Opus) | Avoid if possible |

**Agent Routing Table:**

| Domain | Preferred (Haiku) | Fallback (Sonnet) | Avoid (Opus) |
|--------|-------------------|-------------------|--------------|
| Analysis | architect-low | architect-medium | ~~architect~~ |
| Execution | executor-low | executor | ~~executor-high~~ |
| Search | explore | - | ~~explore-high~~ |
| Frontend | designer-low | designer | ~~designer-high~~ |

Note: Ecomode tries the cheapest option first and only escalates if that fails.

---

## Mode 5: Ecomode - When To Use It

**Best For:**
- Budget-conscious projects
- Iterative development (many small changes)
- Exploratory work
- Personal projects

**Cost Savings Example:**

| Task | Standard Cost | Ecomode Cost | Savings |
|------|--------------|--------------|---------|
| 100 simple fixes | ~$3.00 | ~$0.50 | 83% |
| Feature impl | ~$1.50 | ~$0.75 | 50% |
| Full build | ~$10.00 | ~$5.00 | 50% |

**Trigger:**
```
eco, efficient, save-tokens, budget
```

Note: The key insight is that 80% of tasks can be done by Haiku - you only need Opus for truly complex reasoning.

---
<!-- .slide: data-background="#1a1a2e" -->

# Section 3
## The Agent System

---

## 28 Specialized Agents

| Domain | Agents |
|--------|--------|
| **Analysis** | architect, architect-medium, architect-low |
| **Execution** | executor, executor-high, executor-low |
| **Search** | explore, explore-high |
| **Research** | researcher |
| **Frontend** | designer, designer-high, designer-low |
| **Documentation** | writer |
| **Visual** | vision |
| **Planning** | planner, analyst |
| **Critique** | critic |
| **Testing** | qa-tester |
| **Security** | security-reviewer, security-reviewer-low |
| **Build** | build-fixer |
| **TDD** | tdd-guide, tdd-guide-low |
| **Code Review** | code-reviewer |
| **Data Science** | scientist, scientist-high |

Note: Each agent has a specialized prompt and toolset optimized for its domain.

---

## 3-Tier Model Routing

```
+------------------+------------------+------------------+
|   LOW (Haiku)    |  MEDIUM (Sonnet) |   HIGH (Opus)    |
|------------------|------------------|------------------|
| $0.25/$1.25/1M   | $3/$15/1M        | $15/$75/1M       |
|------------------|------------------|------------------|
| Simple lookups   | Standard work    | Complex reasoning|
| Quick searches   | Feature impl     | Architecture     |
| Basic fixes      | Moderate debug   | Deep debugging   |
| Documentation    | UI components    | Security audits  |
+------------------+------------------+------------------+
         ^                  ^                  ^
         |                  |                  |
   Use by default    Upgrade when     Only when truly
                     LOW fails        necessary
```

**Cost Example:**
- 1000 simple questions: Haiku = $0.25 vs Opus = $15 (60x cheaper!)

Note: The tier system is central to OMC's cost efficiency. Always start low and escalate only when needed.

---

## Smart Delegation

**OMC automatically picks the right agent:**

| Task | Agent Selected | Model |
|------|---------------|-------|
| "What does this function return?" | architect-low | Haiku |
| "Find where UserService is defined" | explore | Haiku |
| "Add validation to login form" | executor-low | Haiku |
| "Implement OAuth2 flow" | executor | Sonnet |
| "Debug race condition in auth" | architect | Opus |
| "Refactor entire auth module" | executor-high | Opus |

**Delegation Code:**
```javascript
Task(
  subagent_type="oh-my-claudecode:executor-low",
  model="haiku",
  prompt="Add validation to the login form"
)
```

Note: The model parameter is always passed explicitly - Claude Code doesn't auto-apply model from agent definitions.

---

## Agent Composition

**Skills + Agents combine for powerful workflows:**

```
"ralph ultrawork: migrate database"
   |        |
   |        +-> Parallel execution (ultrawork)
   +----------> Persistence (ralph)
```

**Real Example:**

```
ralph ultrawork git-master: refactor authentication
  |       |         |
  |       |         +-> Git expertise (atomic commits)
  |       +-----------> Maximum parallelism
  +-------------------> Won't stop until verified complete
```

**Result:** Persistent, parallel, git-aware refactoring

Note: Composition is where OMC really shines - combine behaviors for exactly the workflow you need.

---

## Delegation Categories

**Semantic task categorization with auto-detection:**

| Category | Tier | Temp | Thinking | Auto-Detected From |
|----------|------|------|----------|-------------------|
| `visual-engineering` | HIGH | 0.7 | high | "UI", "component", "style" |
| `ultrabrain` | HIGH | 0.3 | max | "debug", "architecture" |
| `artistry` | MEDIUM | 0.9 | medium | "creative", "brainstorm" |
| `quick` | LOW | 0.1 | low | "find", "what is", "where" |
| `writing` | MEDIUM | 0.5 | medium | "document", "explain" |

**How It Works:**
```
User: "debug the race condition in auth"
            |
            v
     Detected: "debug" keyword
            |
            v
     Category: ultrabrain
            |
            v
     Settings: HIGH tier, temp=0.3, max thinking
```

Note: Categories auto-tune the model parameters for optimal performance on different task types.

---
<!-- .slide: data-background="#1a1a2e" -->

# Section 4
## Live Demo Scenarios

---

## Demo 1: Autopilot

**Command:**
```
autopilot: build a REST API for a bookstore with CRUD operations
```

**What Happens:**

1. **Expansion Phase** (~2 min)
   - Analyst extracts: entities (Book, Author), operations (CRUD), constraints
   - Architect creates: technical spec, database schema, API design

2. **Planning Phase** (~1 min)
   - Architect creates implementation plan
   - Critic validates completeness

3. **Execution Phase** (~10-15 min)
   - Executors implement routes, models, tests in parallel

4. **QA Phase** (~3-5 min)
   - Build, lint, test cycle until green

5. **Validation Phase** (~2 min)
   - Architect, Security, Code Review approve

Note: Live demo would show the HUD tracking progress through each phase.

---

## Demo 2: Ultrawork

**Command:**
```
ulw fix all TypeScript errors
```

**What Happens:**

```
[ULTRAWORK ACTIVATED]

Scanning for TypeScript errors...
Found 23 errors across 8 files.

Spawning parallel agents:
  [executor-low:1] -> src/api/routes.ts (5 errors)
  [executor-low:2] -> src/api/handlers.ts (3 errors)
  [executor-low:3] -> src/ui/App.tsx (4 errors)
  [executor-low:4] -> src/db/models.ts (6 errors)
  [executor-low:5] -> src/utils/helpers.ts (5 errors)

Progress: [====================] 100%

All 23 errors fixed in 2m 34s
Build: PASSING
```

Note: Ultrawork is the raw parallelism mode - no planning overhead, just parallel execution.

---

## Demo 3: Pipeline

**Command:**
```
/pipeline review "add rate limiting to the API"
```

**What Happens:**

```
PIPELINE: review
Stages: explore -> architect -> critic -> executor

[Stage 1/4: explore] RUNNING
  Finding rate limiting patterns in codebase...
  Found: middleware pattern in src/middleware/
  Found: express-rate-limit in dependencies
  OUTPUT: 3 relevant files identified

[Stage 2/4: architect] RUNNING
  Analyzing: existing middleware pattern
  Recommendation: Use express-rate-limit with Redis store
  Design: Per-route configuration
  OUTPUT: Implementation plan created

[Stage 3/4: critic] RUNNING
  Reviewing plan...
  APPROVED with notes: Consider burst handling

[Stage 4/4: executor] RUNNING
  Implementing rate limiting...
  Created: src/middleware/rateLimiter.ts
  Modified: src/api/routes.ts
  OUTPUT: Implementation complete

PIPELINE COMPLETE
```

Note: Pipeline ensures each stage builds on the previous one's output.

---

## Demo 4: Planning

**Command:**
```
plan the authentication system
```

**What Happens:**

```
[PLAN SKILL ACTIVATED]

I'll help you plan the authentication system. Let me ask a few questions:

Q1: What authentication methods do you need?
    [ ] Username/Password
    [ ] OAuth2 (Google, GitHub)
    [ ] Magic Link (email)
    [ ] API Keys

Q2: What session management approach?
    [ ] JWT tokens
    [ ] Server-side sessions
    [ ] Hybrid

Q3: What are your security requirements?
    [ ] 2FA required
    [ ] Password complexity rules
    [ ] Rate limiting on auth endpoints
    [ ] Account lockout after failed attempts

[After user answers...]

Creating implementation plan...
Plan saved to: .omc/plans/auth-system.md
```

Note: Planning mode uses an interactive interview to gather requirements before creating a detailed plan.

---

## Demo 5: Ralph

**Command:**
```
ralph: refactor the auth module to use dependency injection
```

**What Happens:**

```
[RALPH ACTIVATED - Will not stop until verified complete]

Iteration 1/10:
  Analyzing auth module structure...
  Creating refactoring plan...
  Executing changes...
  ERROR: Test failure in auth.test.ts

Iteration 2/10:
  Analyzing failure: Mock not updated for new DI pattern
  Fixing test mocks...
  Re-running tests...
  ERROR: Type error in UserService

Iteration 3/10:
  Fixing UserService types...
  All tests passing...
  Spawning Architect for verification...

[ARCHITECT VERIFICATION]
  Checking: DI pattern correctly applied
  Checking: All tests pass
  Checking: No type errors
  RESULT: APPROVED

[RALPH COMPLETE]
Refactoring verified complete in 3 iterations.
```

Note: Ralph is the persistence mode - it self-corrects and keeps going until an Architect verifies completion.

---
<!-- .slide: data-background="#1a1a2e" -->

# Section 5
## Developer Experience

---

## Magic Keywords

**Optional shortcuts for power users:**

| Keyword | Effect | Example |
|---------|--------|---------|
| `autopilot` | Full autonomous execution | `autopilot: build todo app` |
| `ralph` | Persistence until complete | `ralph: fix auth bugs` |
| `ulw` | Maximum parallelism | `ulw fix all errors` |
| `eco` | Token-efficient execution | `eco: add validation` |
| `plan` | Interactive planning | `plan the API` |
| `ralplan` | Iterative planning consensus | `ralplan new feature` |

**Combinations work:**
```
ralph ulw: migrate database
  ^     ^
  |     +-- parallelism
  +-------- persistence
```

Note: Keywords are optional - natural language works fine. Keywords just give you explicit control.

---

## HUD Statusline

**Real-time visibility into OMC state:**

```
+------------------------------------------------------------+
| OMC | autopilot:exec | 3 agents | 5/12 tasks | ctx:45% | $2.34 |
+------------------------------------------------------------+
      ^               ^          ^            ^         ^
      |               |          |            |         |
   Active mode    # running   Progress    Context    Cost
                  agents                  window
```

**Setup:**
```
/oh-my-claudecode:hud setup
```

**Presets:**
- `minimal` - Just active mode
- `focused` - Mode + progress (default)
- `full` - Everything including cost

Note: The HUD integrates with Claude Code's statusLine API to show real-time orchestration state.

---

## Notepad Wisdom System

**Plan-scoped knowledge capture:**

Location: `.omc/notepads/{plan-name}/`

| File | Purpose | Example |
|------|---------|---------|
| `learnings.md` | Technical discoveries | "Redis requires explicit TTL for rate limit keys" |
| `decisions.md` | Design decisions | "Chose JWT over sessions for stateless scaling" |
| `issues.md` | Known issues | "OAuth callback URL must be HTTPS in prod" |
| `problems.md` | Blockers | "Need Redis instance for rate limiting" |

**API:**
```javascript
addLearning("plan-auth", "OAuth refresh tokens expire after 7 days")
addDecision("plan-auth", "Using passport.js for OAuth integration")
getWisdomSummary("plan-auth")
```

Note: Wisdom persists across sessions - future work on the same plan gets this context automatically.

---

## Analytics & Cost Tracking

**Track token usage and costs:**

```
$ omc-analytics summary

Session Summary (last 7 days)
-----------------------------
Total sessions: 23
Total tokens: 1,234,567
Total cost: $18.45

By Model:
  Haiku:  890,000 tokens  ($0.89)
  Sonnet: 300,000 tokens  ($4.50)
  Opus:    44,567 tokens  ($13.06)

By Mode:
  autopilot:  45% of cost
  ultrawork:  30% of cost
  :    10% of cost
  other:      15% of cost

Top 5 Expensive Sessions:
  1. "build fullstack app"     $4.23
  2. "debug auth race cond"    $2.15
  3. "refactor database"       $1.89
  ...
```

Note: Analytics help you understand where tokens are going and optimize your usage patterns.

---
<!-- .slide: data-background="#1a1a2e" -->

# Section 6
## Getting Started

---

## Installation

**Method 1: Plugin Marketplace (Recommended)**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Method 2: NPM Global**
```bash
npm install -g oh-my-claudecode
```

**Method 3: Manual Git Clone**
```bash
git clone https://github.com/Yeachan-Heo/oh-my-claudecode.git
cd oh-my-claudecode
npm install && npm run build
```

**Requirements:**
- Claude Code CLI
- Claude Max/Pro subscription OR Anthropic API key
- Node.js 20+

Note: Plugin marketplace is the easiest - one command and you're done.

---

## First Steps

**Step 1: Install**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Step 2: Setup**
```bash
/oh-my-claudecode:omc-setup
```
(Configures defaults, HUD, preferences)

**Step 3: Build something**
```
autopilot: build a REST API for managing tasks
```

**That's it.** Everything else is automatic.

Note: Zero learning curve means you can start using OMC immediately after installation.

---

## Configuration

**Project-level:** `CLAUDE.md` in project root
**Global:** `~/.claude/CLAUDE.md`

**Key Settings:**

```json
// ~/.claude/settings.json
{
  "omc": {
    "defaultExecutionMode": "ultrawork",  // or ""
    "autopilot": {
      "maxIterations": 10,
      "maxQaCycles": 5,
      "skipValidation": false
    },
    "hud": {
      "preset": "focused"
    }
  }
}
```

**Agent Customization:**
- Modify agent prompts in `agents/*.md`
- Override tools per agent
- Create custom agents

Note: Most users never need to configure anything - defaults work well for typical usage.

---
<!-- .slide: data-background="#1a1a2e" -->

# Section 7
## Closing

---

## Real-World Use Cases

| Use Case | Best Mode | Why |
|----------|-----------|-----|
| **Backend API development** | autopilot | Full end-to-end workflow |
| **Frontend component library** | ultrapilot | Many independent components |
| **Database migrations** | ralph | Needs persistence through errors |
| **CI/CD pipeline setup** | pipeline:implement | Sequential stages |
| **Documentation generation** | swarm:writer | Parallel doc writing |
| **Bug triage & fixing** | swarm:executor | Many independent fixes |
| **Security audit** | pipeline:security | Structured review process |
| **Exploratory prototyping** |  | Budget-conscious iteration |

Note: Matching the right mode to the task type is key to getting the most out of OMC.

---

## Resources

**GitHub Repository**
```
github.com/Yeachan-Heo/oh-my-claudecode
```

**Website & Documentation**
```
yeachan-heo.github.io/oh-my-claudecode-website
```

**NPM Package**
```
npm install -g oh-my-claudecode
```

**Documentation Directory**
```
/docs/REFERENCE.md      - Complete feature reference
/docs/MIGRATION.md      - Upgrade guide
/docs/ARCHITECTURE.md   - How it works
```

**Getting Help**
```
/oh-my-claudecode:omc-help    - Usage guide
/oh-my-claudecode:omc-doctor  - Diagnose issues
```

Note: The GitHub repo has all documentation, examples, and issue tracking.

---

## Q&A

**Common Questions:**

| Question | Answer |
|----------|--------|
| Does OMC work with Claude API keys? | Yes, both Max/Pro subscription and API keys work |
| Can I use OMC with other AI models? | No, OMC is specifically for Claude Code |
| How do I stop a runaway autopilot? | Say "stop", "cancel", or `/oh-my-claudecode:cancel` |
| Why is my HUD not showing? | Run `/oh-my-claudecode:hud setup` |
| Can I create custom agents? | Yes, add `.md` files to `agents/` directory |
| Is there a cost limit? | No built-in limit, but  helps control costs |

**Questions?**

Note: Thank you for attending! Feel free to reach out via GitHub issues for any questions.

---

## Thank You

**oh-my-claudecode**

Zero learning curve. Maximum power.

```
github.com/Yeachan-Heo/oh-my-claudecode
```

**Get Started Now:**
```
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
autopilot: build something amazing
```

---

## Appendix A: Complete Agent Reference

| Agent | Model | Best For |
|-------|-------|----------|
| architect | opus | Complex architecture, deep debugging |
| architect-medium | sonnet | Moderate analysis |
| architect-low | haiku | Quick code questions |
| executor | sonnet | Standard implementation |
| executor-high | opus | Complex refactoring |
| executor-low | haiku | Simple fixes |
| explore | haiku | Fast file search |
| explore-high | opus | Architectural search |
| designer | sonnet | UI components |
| designer-high | opus | Design systems |
| designer-low | haiku | Simple styling |

--

## Appendix A: Complete Agent Reference (continued)

| Agent | Model | Best For |
|-------|-------|----------|
| researcher | sonnet | External docs, APIs |
| writer | haiku | Documentation |
| vision | sonnet | Image analysis |
| planner | opus | Strategic planning |
| analyst | opus | Requirements extraction |
| critic | opus | Plan review |
| qa-tester | sonnet | CLI testing |
| security-reviewer | opus | Security audits |
| security-reviewer-low | haiku | Quick security scan |

--

## Appendix A: Complete Agent Reference (continued)

| Agent | Model | Best For |
|-------|-------|----------|
| build-fixer | sonnet | Build error resolution |
| tdd-guide | sonnet | TDD workflow |
| tdd-guide-low | haiku | Quick test suggestions |
| code-reviewer | opus | Code quality review |
| scientist | sonnet | Data analysis |
| scientist-high | opus | Complex ML/hypothesis |

---

## Appendix B: Complete Skill Reference

| Skill | Purpose | Trigger |
|-------|---------|---------|
| autopilot | Full autonomous execution | "autopilot", "build me" |
| ultrapilot | Parallel autopilot | "ultrapilot", "parallel build" |
| ralph | Persistence mode | "ralph", "don't stop" |
| ultrawork | Maximum parallelism | "ulw", "ultrawork" |
|  | Token-efficient mode | "eco", "budget" |
| swarm | Coordinated agents | `/swarm N:agent` |
| pipeline | Sequential chaining | `/pipeline preset` |
| plan | Planning interview | "plan the" |
| ralplan | Iterative planning | "ralplan" |
| cancel | Stop any mode | "stop", "cancel" |

--

## Appendix B: Complete Skill Reference (continued)

| Skill | Purpose | Trigger |
|-------|---------|---------|
| analyze | Deep investigation | "analyze", "debug" |
| deepsearch | Thorough search | "search", "find" |
| deepinit | Generate AGENTS.md | "index codebase" |
| frontend-ui-ux | Design sensibility | UI context (auto) |
| git-master | Git expertise | Git context (auto) |
| ultraqa | QA cycling | "test", "QA" |
| learner | Extract skills | "extract skill" |
| note | Save to notepad | "remember", "note" |
| hud | Configure HUD | `/hud` |
| doctor | Diagnose issues | `/doctor` |

--

## Appendix B: Complete Skill Reference (continued)

| Skill | Purpose | Trigger |
|-------|---------|---------|
| help | Show usage guide | `/help` |
| omc-setup | Setup wizard | `/omc-setup` |
| ralph-init | Initialize PRD | `/ralph-init` |
| release | Release workflow | `/release` |
| review | Review plan | "review plan" |
| research | Scientist orchestration | "research", "statistics" |
| tdd | TDD enforcement | "tdd", "test first" |
| mcp-setup | Configure MCP | "setup mcp" |

---

## Appendix C: Keyboard Shortcuts Summary

| Shortcut | Full Command | Effect |
|----------|--------------|--------|
| `autopilot:` | `/oh-my-claudecode:autopilot` | Full autonomous mode |
| `ralph:` | `/oh-my-claudecode:ralph` | Persistence mode |
| `ulw` | `/oh-my-claudecode:ultrawork` | Parallel execution |
| `eco:` | `/oh-my-claudecode:` | Token-efficient mode |
| `plan` | `/oh-my-claudecode:plan` | Planning interview |

**Combinations:**
```
ralph ulw: task        # Persistent + Parallel
ralph eco: task        # Persistent + Efficient
autopilot eco: task    # Auto + Efficient (eco wins)
```

Note: When keywords conflict, more restrictive mode wins (eco beats ulw).
