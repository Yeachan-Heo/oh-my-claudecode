# Speaker Notes: oh-my-claudecode Seminar

## Time Allocation (60 minutes total)
| Section | Time | Slides |
|---------|------|--------|
| Opening & Problem Statement | 5 min | 1-3 |
| What is OMC? | 8 min | 4-8 |
| Execution Modes Deep Dive | 20 min | 9-23 |
| Agent System | 7 min | 24-28 |
| Live Demos | 12 min | 29-33 |
| Developer Experience | 4 min | 34-37 |
| Getting Started | 2 min | 38-40 |
| Closing & Q&A | 2 min | 41-43 |

---

## Section 1: Opening & Problem Statement (5 min, Slides 1-3)

### Opening Line
"Show of hands - who here has spent more time explaining to their AI assistant what you want than it would have taken to just write the code yourself?"

### Key Points
- AI assistants today are single-threaded, generalist tools
- Context switching between exploration, implementation, testing is manual
- No specialization means every task uses the same expensive model
- Users become project managers instead of developers
- The promise vs reality gap: We wanted autonomous coding, we got interactive tutoring

### Talking Points

**The Current State Pain**
- "Right now, when you use Claude Code or similar tools, you're essentially getting a very smart intern. They can do anything you ask, but YOU have to manage the workflow."
- "You find yourself saying things like: 'First search for the authentication code. Now analyze it. Now write a test. Now run the test. Now fix the error. Now check if there are similar patterns elsewhere.'"
- "It's like conducting an orchestra where you have to tell each musician exactly when to play each note. Exhausting."

**The Mental Load**
- "The cognitive overhead is massive. You're not just thinking about the problem - you're thinking about how to SEQUENCE the solution."
- "And here's the kicker: you're paying Opus-level prices for tasks that could be done with Haiku. It's like hiring a senior architect to fetch coffee."

**The Vision**
- "What if your AI assistant could ORCHESTRATE the work instead of just DOING the work?"
- "What if you could say 'build me a REST API' and specialists for planning, implementation, testing, and documentation all kicked in automatically?"
- "What if the AI could run multiple specialists in parallel, route tasks to the right model tier, and persist until verification passes?"

**The Reveal**
- "That's exactly what oh-my-claudecode does. It transforms Claude Code from a single generalist assistant into a coordinated team of 28 specialists."
- "Today, I'm going to show you how this changes everything about AI-assisted development."

### Transition
"Let me start by showing you exactly what OMC is and how it thinks differently about AI assistance."

### Audience Engagement
- Ask for the opening show of hands
- "Has anyone here tried to use AI for a multi-step refactoring? How'd that go?" (Get 1-2 quick responses)
- Watch for nodding heads during pain points - those are your engaged audience members

---

## Section 2: What is OMC? (8 min, Slides 4-8)

### Opening Line
"The fundamental insight behind OMC is simple: your AI should be a conductor, not a performer."

### Key Points
- The conductor metaphor: orchestrates specialists rather than doing everything
- Mental model shift from interactive assistant to autonomous orchestrator
- Architecture: natural language → intent detection → skill routing → agent delegation
- Zero configuration: works out of the box with intelligent defaults
- Three core innovations: multi-agent orchestration, model tier routing, execution modes

### Talking Points

**The Conductor Metaphor** (Slide 4)
- "Think about an orchestra conductor. They don't play the violin, the timpani, or the trumpet. They COORDINATE the specialists who do."
- "That's the shift OMC makes. Claude becomes the conductor, and 28 specialized agents are the orchestra."
- "When you say 'build a feature,' Claude doesn't do it all personally. It delegates: Explorer finds relevant code, Architect designs the solution, Executor implements, QA Tester verifies."

**Before vs After** (Slide 5)
- "BEFORE: 'Claude, search for auth code.' [wait] 'Now analyze it.' [wait] 'Now write tests.' [wait] You're the project manager micromanaging every step."
- "AFTER: 'Build authentication for the API.' OMC automatically: explores codebase, analyzes requirements, generates plan, implements in parallel, writes tests, verifies. You're the product owner stating the goal."
- "This isn't a minor improvement. This is a 10x workflow change."

**Architecture Flow** (Slide 6)
- "Here's how it works end-to-end:"
- "1. You speak naturally: 'Fix all TypeScript errors'"
- "2. Claude detects intent: This is a parallel execution task"
- "3. Routes to skill: Ultrawork mode activates"
- "4. Delegates to agents: Multiple executor agents spawn in parallel"
- "5. Results verified: Architect agent confirms all errors resolved"
- "You never had to say 'use ultrawork' or 'spawn 3 executors' or 'verify with architect'. It's all automatic."

**The Numbers** (Slide 7)
- "28 specialized agents across 13 domains - architecture, execution, search, frontend, testing, security, documentation, and more"
- "37 skills that combine these agents into workflows - autopilot, planning, persistence, parallelism"
- "3 model tiers - Haiku for speed and cost, Sonnet for balance, Opus for complex reasoning"
- "Zero configuration files, zero setup beyond installation"

**Core Innovations** (Slide 8)
- "Three things make OMC unique:"
- "1. MULTI-AGENT ORCHESTRATION: Tasks automatically decompose and distribute to specialists"
- "2. SMART MODEL ROUTING: Simple tasks use cheap Haiku, complex tasks use powerful Opus - saves 30-50% on costs"
- "3. EXECUTION MODES: Autopilot, Ultrapilot, Swarm, Pipeline, Ecomode - each optimized for different scenarios"

### Transition
"That third innovation - execution modes - is where things get really interesting. Let's dive deep into each one."

### Audience Engagement
- "Quick poll: How many of you would rather state WHAT you want versus HOW to do it?" (Expect all hands)
- Point to specific people when mentioning pain points: "You know what I'm talking about, right?"
- "The architecture might seem complex, but here's the thing - you never see it. It's all under the hood."

---

## Section 3: Execution Modes Deep Dive (20 min, Slides 9-23)

### Opening Line
"Execution modes are where OMC's power becomes concrete. Each mode is optimized for a specific type of work. Let's explore all five."

### Mode 1: Autopilot (4 min, Slides 9-11)

**Opening Line**
"Autopilot is the flagship feature - full autonomous execution from idea to working code."

**Key Points**
- Complete autonomy: You state the goal, everything else is automatic
- Combines best of all modes: planning, persistence, parallelism, verification
- Ideal for greenfield development and new features
- No intervention required until completion

**Talking Points**

**The Self-Driving Car Analogy** (Slide 9)
- "Autopilot is like a self-driving car. You tell it the destination - 'Build a REST API for task management' - and it handles navigation, traffic, route optimization, everything."
- "You don't touch the wheel. You don't press the pedals. You state where you're going and trust the system."

**What Happens Under the Hood** (Slide 10)
- "When autopilot activates, here's the sequence:"
- "1. PLANNING: Analyst explores codebase, Planner interviews you for requirements, Critic reviews the plan"
- "2. EXECUTION: Tasks decompose, agents execute in parallel, results integrate continuously"
- "3. VERIFICATION: Build passes, tests pass, linting passes, Architect verifies functionality"
- "4. PERSISTENCE: If verification fails, automatically fixes and re-verifies. Won't stop until success."
- "All of this from one command: 'autopilot: build task management API'"

**When to Use** (Slide 11)
- "Perfect for: New features, greenfield projects, 'build me a...' requests"
- "Not ideal for: Quick bug fixes, single file changes, exploratory debugging"
- "If you're starting something from scratch, autopilot is your best friend."

**Real-World Example**
- "I recently said: 'autopilot: add OAuth authentication to my Express API'"
- "It explored the codebase, found the auth patterns, generated a plan, implemented passport.js integration, wrote tests, verified with security-reviewer. Total human input: one sentence."

### Mode 2: Ultrapilot (4 min, Slides 12-14)

**Opening Line**
"Ultrapilot is autopilot on steroids - up to 5 concurrent workers executing in parallel."

**Key Points**
- 3-5x faster than autopilot via parallelism
- File ownership coordinator prevents conflicts
- Ideal for multi-component systems
- Task decomposition engine breaks work into independent chunks

**Talking Points**

**The Pit Crew Analogy** (Slide 12)
- "Think of a Formula 1 pit crew. When a car comes in, you don't have one person change all four tires sequentially. Four people work simultaneously, each on one tire."
- "Ultrapilot does the same. If you're building a fullstack app, one worker handles the database layer, another the API routes, another the frontend components, another the tests - all at once."

**The Coordination Challenge** (Slide 13)
- "The hard part isn't running agents in parallel - it's preventing them from stepping on each other."
- "Ultrapilot has a file ownership coordinator. Each worker 'claims' the files they're working on. Shared files go through conflict resolution."
- "Task decomposition engine analyzes dependencies: 'Database schema must complete before API routes can start' - it builds a dependency graph and schedules optimally."

**When to Use** (Slide 14)
- "Perfect for: Fullstack features, multi-component systems, large refactorings"
- "Not ideal for: Single-file changes, tasks with heavy interdependencies, exploratory work"
- "If you trigger ultrapilot on a simple bug fix, you're using a sledgehammer on a thumbtack."

**Performance Numbers**
- "Real-world metrics: Building a CRUD API with auth, validation, and tests took autopilot 8 minutes. Ultrapilot did it in 2.5 minutes."
- "But here's the caveat: ultrapilot uses more tokens because of parallel agents. That's where our next mode comes in."

### Mode 3: Swarm (4 min, Slides 15-17)

**Opening Line**
"Swarm mode takes a different approach to parallelism - independent workers claiming tasks from a shared queue."

**Key Points**
- Atomic task claiming prevents conflicts
- Dynamic scaling from 2-10 agents
- 5-minute timeout per task with auto-release
- Ideal for homogeneous parallel work

**Talking Points**

**The Ant Colony Analogy** (Slide 15)
- "Watch an ant colony. There's no central coordinator telling each ant what to do. They have a shared objective (food pile) and workers independently claim and complete tasks."
- "Swarm works the same. You define a pool of tasks: 'Fix these 47 TypeScript errors.' Each agent grabs one, fixes it, marks it done, grabs the next."

**How Task Claiming Works** (Slide 16)
- "Every task has a status: PENDING, CLAIMED, DONE"
- "When an agent is idle, it atomically claims a PENDING task (meaning no two agents can claim the same task)"
- "It has 5 minutes to complete. If it times out, the task auto-releases back to PENDING"
- "The swarm completes when all tasks are DONE"

**When to Use** (Slide 17)
- "Perfect for: Batch fixes, test suite repairs, linting errors, documentation updates"
- "Not ideal for: Sequential workflows, interdependent tasks, single complex tasks"
- "If your tasks can be done in any order and don't depend on each other, swarm shines."

**Comparison with Ultrapilot**
- "Ultrapilot: Coordinator orchestrates workers on a complex multi-stage project"
- "Swarm: Workers self-organize on many independent tasks"
- "Ultrapilot is a construction crew building a house. Swarm is a cleaning crew each tackling different rooms."

### Mode 4: Pipeline (4 min, Slides 18-20)

**Opening Line**
"Pipeline mode is for when you need sequential stages with data passing between them."

**Key Points**
- Sequential execution with stage outputs feeding next stage
- 6 built-in presets for common workflows
- Custom pipelines via simple syntax
- Ideal for multi-stage analysis and review workflows

**Talking Points**

**The Assembly Line Analogy** (Slide 18)
- "Think of an automotive assembly line. Chassis construction → Engine installation → Electrical wiring → Quality inspection. Each stage adds value and passes to the next."
- "Pipeline mode does exactly this with your code. Stage 1: Explorer finds relevant code. Stage 2: Architect analyzes issues. Stage 3: Executor implements fixes. Stage 4: QA Tester verifies."

**Built-in Presets** (Slide 19)
- "Six presets cover common workflows:"
- "REVIEW: explore → architect → critic → executor (for code reviews)"
- "IMPLEMENT: planner → executor → tdd-guide (for TDD workflows)"
- "DEBUG: explore → architect → build-fixer (for debugging)"
- "RESEARCH: parallel(researcher, explore) → architect → writer (for documentation)"
- "REFACTOR: explore → architect-medium → executor-high → qa-tester"
- "SECURITY: explore → security-reviewer → executor → security-reviewer-low (audit & fix)"

**Custom Pipelines** (Slide 20)
- "You can define custom pipelines with simple syntax:"
- "`/pipeline explore:haiku -> architect:opus -> executor:sonnet`"
- "Each stage specifies agent and model tier. Output from one stage passes to the next as context."

**When to Use**
- "Perfect for: Code reviews, security audits, research workflows, anything with clear stages"
- "Not ideal for: Parallel work, single-step tasks, exploratory debugging"

### Mode 5: Ecomode (4 min, Slides 21-23)

**Opening Line**
"Ecomode is designed for one thing: maximum efficiency at minimum cost."

**Key Points**
- Token-efficient parallelism via smart batching
- Prefers lower-tier models when possible
- Still gets the job done, just more economically
- 40-60% cost reduction vs ultrawork

**Talking Points**

**The Economy Class Analogy** (Slide 21)
- "Ecomode is like flying economy class. You get to the same destination, just with fewer frills and lower cost."
- "It still uses parallelism, but batches tasks more aggressively, prefers Haiku/Sonnet over Opus, and optimizes for token efficiency."

**How It Optimizes** (Slide 22)
- "Three optimization strategies:"
- "1. AGGRESSIVE BATCHING: Groups similar tasks to reduce context switching overhead"
- "2. MODEL DOWNGRADING: Uses Haiku for tasks that ultrawork would use Sonnet for"
- "3. CONTEXT MINIMIZATION: Passes only essential information between agents"

**When to Use** (Slide 23)
- "Perfect for: Budget-conscious work, large batch operations, CI/CD integration"
- "Not ideal for: Time-critical work, complex reasoning tasks, when quality matters more than cost"
- "If you're working on open-source with limited API budget is your mode."

**Cost Comparison**
- "Real numbers: Fixing 50 TypeScript errors with ultrawork: ~200K tokens ($2.40). Same task with : ~85K tokens ($1.02)."
- "You're trading some speed and sophistication for cost. Sometimes that's exactly the right tradeoff."

### Mode Comparison Table (Quick Reference)

| Mode | Speed | Cost | Parallelism | Best For |
|------|-------|------|-------------|----------|
| Autopilot | Medium | Medium | Adaptive | New features, greenfield |
| Ultrapilot | Fastest | Highest | High (5 workers) | Multi-component systems |
| Swarm | Fast | Medium-High | Dynamic (2-10) | Batch fixes, homogeneous tasks |
| Pipeline | Medium | Medium | Sequential | Reviews, audits, research |
| Ecomode | Medium | Lowest | Efficient | Budget-conscious, batch ops |

### Transition
"These modes are powered by OMC's agent system. Let's look at how those 28 specialists are organized."

### Audience Engagement
- "Quick question: Which mode sounds most useful for YOUR daily work?" (Take 2-3 responses)
- "The beauty is you don't have to memorize this. Say 'fast parallel fixes' and OMC activates ultrawork. Say 'efficient batch fixes' and it activates ."
- Watch for confused faces during technical explanations - offer to elaborate if needed

---

## Section 4: Agent System (7 min, Slides 24-28)

### Opening Line
"Behind every execution mode is a team of specialized agents. Let's explore how they're organized."

### Key Points
- 13 domain areas covering all aspects of development
- 3-tier model system: Haiku (LOW), Sonnet (MEDIUM), Opus (HIGH)
- Smart routing saves 30-50% on token costs
- Agents compose into higher-level skills

**Talking Points**

**The 13 Domains** (Slide 24)
- "OMC organizes agents into 13 specializations:"
- "ANALYSIS: architect-low, architect-medium, architect (debugging, root cause)"
- "EXECUTION: executor-low, executor, executor-high (code implementation)"
- "SEARCH: explore, explore-high (codebase exploration)"
- "RESEARCH: researcher (API docs, external research)"
- "FRONTEND: designer-low, designer, designer-high (UI/UX, components)"
- "DOCUMENTATION: writer (technical writing, comments)"
- "VISUAL: vision (image/diagram analysis)"
- "PLANNING: planner, analyst, critic (strategic planning)"
- "TESTING: qa-tester (interactive testing)"
- "SECURITY: security-reviewer-low, security-reviewer (audits)"
- "BUILD: build-fixer (build error resolution)"
- "TDD: tdd-guide-low, tdd-guide (test-first workflows)"
- "CODE REVIEW: code-reviewer (PR reviews)"
- "DATA SCIENCE: scientist, scientist-high (analysis, ML)"

**The 3-Tier System** (Slide 25)
- "Each domain has up to three tiers corresponding to Claude model versions:"
- "HAIKU (LOW): Fast, cheap, perfect for simple tasks. 'Find the definition of this function' - why use Opus?"
- "SONNET (MEDIUM): Balanced reasoning and cost. 'Implement this feature with error handling' - the sweet spot."
- "OPUS (HIGH): Maximum reasoning power. 'Debug this race condition' or 'Architect this system' - when quality matters most."

**Smart Routing Examples** (Slide 26)
- "Let me show you the cost impact with real examples:"
- "TASK: 'Find all usages of the Auth class'"
- "  Without routing: Uses Opus by default → 15K tokens @ $15 per million = $0.225"
- "  With routing: Uses explore (Haiku) → 8K tokens @ $0.25 per million = $0.002"
- "  Savings: 99% on this task"
- ""
- "TASK: 'Implement OAuth with token refresh and error handling'"
- "  Without routing: Uses Opus throughout → 80K tokens = $1.20"
- "  With routing: Uses executor (Sonnet) → 45K tokens = $0.135"
- "  Savings: 89% on this task"
- ""
- "TASK: 'Debug why the WebSocket reconnection logic fails intermittently'"
- "  Without routing: Might use Sonnet → struggles, takes 3 rounds"
- "  With routing: Uses architect (Opus) → solves in 1 round"
- "  Savings: Negative cost, but 3x faster time-to-solution"

**Agent Composition** (Slide 27)
- "Skills combine agents into workflows. For example:"
- "AUTOPILOT skill = analyst + planner + critic + (executor + qa-tester + build-fixer) loop + architect verification"
- "DEEPSEARCH skill = explore + architect-medium + writer"
- "FRONTEND-UI-UX skill = designer-high + executor + qa-tester"
- "You invoke skills, skills invoke agents. It's turtles all the way down."

**The Selection Decision Tree** (Slide 28)
- "How does OMC decide which agent to use? Three factors:"
- "1. TASK COMPLEXITY: Keyword detection ('simple' → LOW, 'complex' → HIGH)"
- "2. DELEGATION CATEGORY: Visual-engineering → HIGH, Quick → LOW, Ultrabrain → HIGH"
- "3. EXECUTION MODE: Ecomode prefers LOW tier, standard modes use natural tier"
- "This happens automatically. You don't think about it."

### Transition
"Theory is great, but let's see this in action. Time for live demos."

### Audience Engagement
- "Anyone here shocked by those cost savings numbers? That's real money at scale."
- "The key insight: Not all tasks need your smartest model. Match the tool to the job."

---

## Section 5: Live Demos (12 min, Slides 29-33)

### Opening Line
"Enough talking about it. Let's see OMC in action across five different scenarios."

### Demo 1: Autopilot - Full Feature Build (5 min, Slide 29)

**Setup**
- Have terminal ready with OMC installed
- Prepare fallback recording in case of failure
- Clear any previous state files

**Demo Script**
```
Say: "I'm going to build a complete REST API endpoint from scratch using autopilot."

Type: "autopilot: build a POST /api/tasks endpoint with validation, error handling, and tests"

Narrate while it runs:
- "Notice the HUD at the bottom showing active agents"
- "Analyst is exploring the codebase to understand existing patterns"
- "Planner is drafting a plan - it's asking me about database choice"
- [Answer planning questions interactively]
- "Now multiple executors are implementing in parallel"
- "QA tester is writing integration tests"
- "Build-fixer is ensuring everything compiles"
- "Architect is doing final verification"

When complete:
- Show the generated code files
- Run the tests to prove they pass
- Show the HUD status: all agents completed
```

**Talking Points While Demo Runs**
- "This is the zero-config experience. I didn't specify which agents to use, which models, how to parallelize. All automatic."
- "The planning interview is optional - if I'd given more detail upfront, it would skip straight to execution."
- "Watch the HUD - you can see exactly which agents are active at any moment."
- "If any test fails, it automatically enters the fix-verify loop. Won't claim completion until architect approves."

**Fallback Plan**
- If demo is slow: "This is taking a bit, let me show you a recorded version running at normal speed" [switch to recording]
- If demo fails: "Interesting - let me show you a successful run" [switch to recording]
- If API is down: Use recordings exclusively

### Demo 2: Ultrawork - Parallel Error Fixing (3 min, Slide 30)

**Setup**
- Have a project with multiple TypeScript errors ready
- Could be the OMC codebase itself with intentional errors

**Demo Script**
```
Say: "Now let's see parallel execution with ultrawork."

Type: "ulw fix all TypeScript errors"

Narrate:
- "Multiple executor agents spawning"
- "Each is claiming different files"
- "Watch the HUD - you'll see executor-1, executor-2, executor-3 all active"
- "They're working simultaneously on different errors"

When complete:
- Run tsc --noEmit to show zero errors
- Show git diff to see all the fixes
```

**Talking Points**
- "This is the power of parallelism. Sequentially, this would take 5-10 minutes. Parallel, under 2 minutes."
- "The agents coordinate automatically - no file conflicts, no race conditions."

### Demo 3: Pipeline - Code Review Workflow (2 min, Slide 31)

**Setup**
- Have a recent commit or branch ready for review

**Demo Script**
```
Say: "Pipeline mode for a code review workflow."

Type: "/pipeline review" [on a recent commit]

Narrate:
- "Stage 1: Explorer finds changed files"
- "Stage 2: Architect analyzes changes for issues"
- "Stage 3: Critic reviews architecture decisions"
- "Stage 4: Executor suggests improvements"
- "Output from each stage feeds into the next"

Show final output:
- Structured review with findings and suggestions
```

**Talking Points**
- "Each stage adds value. Explorer provides context, Architect provides analysis, Critic provides judgment, Executor provides solutions."
- "This is a built-in preset, but you could customize the stages for your workflow."

### Demo 4: Planning Interview (1 min, Slide 32)

**Setup**
- Be ready with a vague request

**Demo Script**
```
Say: "Quick demo of the planning interview."

Type: "plan: improve the authentication system"

Narrate:
- "Notice it's asking preference questions, not implementation details"
- "Should we prioritize security or ease of use?"
- "OAuth, JWT, or session-based?"
- [Answer 1-2 questions]
- "It generates a concrete plan from our discussion"
```

**Talking Points**
- "Planning is collaborative. You provide direction, it provides expertise."

### Demo 5: Ralph - Persistence Mode (1 min, Slide 33)

**Setup**
- Have a task that might fail initially (e.g., test that needs fixing)

**Demo Script**
```
Say: "Ralph mode won't stop until verification passes."

Type: "ralph: make all tests pass"

Narrate:
- "Tests run and some fail"
- "Architect analyzes failures"
- "Executor implements fixes"
- "Tests run again - still some failures"
- "Fix-verify loop continues automatically"
- "Eventually: all tests pass, architect approves, ralph exits"
```

**Talking Points**
- "Ralph is your 'don't stop until done' mode. Perfect for stubborn bugs or end-of-day cleanup."

### Transition
"You've seen the power. Now let's talk about the developer experience that makes this all accessible."

### Audience Engagement
- During demos, ask: "Any questions about what you're seeing?"
- If demos are going well: "Want to see any of these again with a different scenario?"
- If ahead on time: Take an extra demo request
- If behind on time: Skip demo 4 or 5

---

## Section 6: Developer Experience (4 min, Slides 34-37)

### Opening Line
"Powerful technology is useless if it's hard to use. OMC is designed for zero learning curve."

### Key Points
- Magic keywords for zero learning curve
- HUD statusline for real-time visibility
- Notepad wisdom system for learning
- Cost analytics for budget awareness

**Talking Points**

**Magic Keywords** (Slide 34)
- "You don't need to memorize commands. Natural language works:"
- "Say 'build me a dashboard' → autopilot activates"
- "Say 'don't stop until done' → ralph activates"
- "Say 'fix all errors fast' → ultrawork activates"
- "Say 'efficient batch fixes' →  activates"
- ""
- "Power users have shortcuts:"
- "`ulw` = ultrawork, `eco` = `ralplan` = ralph + planning"
- "But shortcuts are optional. Natural language is first-class."

**The HUD** (Slide 35)
- "The HUD gives real-time visibility into the agent swarm:"
```
[OMC] Mode: ultrawork | Agents: 3 active | executor-1: fixing auth.ts | executor-2: fixing api.ts | architect: reviewing
```
- "At a glance you know:"
- "  Which mode is active"
- "  How many agents are working"
- "  What each agent is doing"
- "Installation: `/oh-my-claudecode:hud setup` - adds to your shell prompt"

**Notepad Wisdom** (Slide 36)
- "OMC learns from every session via the notepad system:"
- "Location: `.omc/notepads/{plan-name}/`"
- "  learnings.md - Technical patterns discovered"
- "  decisions.md - Architectural choices and rationale"
- "  issues.md - Known problems and workarounds"
- "  problems.md - Current blockers"
- ""
- "Example learning: 'When modifying TypeScript interfaces, always run tsc --noEmit before committing to catch downstream breakages.'"
- "These persist across sessions. Your OMC gets smarter over time."

**Cost Analytics** (Slide 37)
- "OMC tracks token usage per session:"
- "See exactly how much each mode costs"
- "Compare ultrawork vs  for your workload"
- "Audit logs at `.omc/logs/delegation-audit.jsonl`"
- "Know your costs before they surprise you."

### Transition
"Sold? Let's get you started."

### Audience Engagement
- "Who here uses shell customizations like starship or oh-my-zsh? The HUD integrates beautifully."
- "The notepad system is opt-in. You can ignore it entirely, but power users love it."

---

## Section 7: Getting Started (2 min, Slides 38-40)

### Opening Line
"Getting started is three commands and takes under 2 minutes."

### Key Points
- Requires Claude Code CLI installed
- Three-step installation
- One-time setup wizard
- Works immediately after setup

**Talking Points**

**Prerequisites** (Slide 38)
- "You need Claude Code installed: `npm install -g claude-code`"
- "You need a Claude subscription (Pro or Team) or an API key"
- "That's it. No Docker, no databases, no complex dependencies."

**Installation** (Slide 39)
```bash
# Step 1: Install OMC
npm install -g oh-my-claudecode

# Step 2: Run setup wizard
claude-code "/oh-my-claudecode:omc-setup"

# Step 3: Start using it
claude-code "autopilot: build me a todo app"
```

**What Setup Does** (Slide 40)
- "The setup wizard configures:"
- "  Default execution mode (ultrawork or )"
- "  HUD installation (optional)"
- "  Analytics preferences (optional)"
- "  Agent customizations (optional)"
- ""
- "Takes 60 seconds. After that, just start describing what you want to build."

### Transition
"That's OMC. Let's recap and open for questions."

### Audience Engagement
- "Who's ready to try this on their project this week?" (Show of hands)
- "I'll drop the GitHub link in the chat now so you can bookmark it."

---

## Section 8: Closing & Q&A (2 min, Slides 41-43)

### Opening Line
"Let's recap what makes OMC transformative."

### Key Points
- Shift from interactive assistant to autonomous orchestrator
- Five execution modes for different scenarios
- 28 specialized agents with smart model routing
- Zero learning curve, works with natural language
- Free and open-source (MIT license)

**Talking Points**

**The Big Picture** (Slide 41)
- "OMC transforms Claude Code from a single assistant into a coordinated team."
- "You go from micromanaging every step to stating goals and getting results."
- "The five execution modes cover everything: greenfield (autopilot), parallel (ultrawork/ultrapilot), batch (swarm), sequential (pipeline), budget ()."
- "28 agents with 3-tier model routing save you 30-50% on costs while getting work done faster."

**Resources** (Slide 42)
- "GitHub: github.com/Yeachan-Heo/oh-my-claudecode"
- "Documentation: Full guides in the repo README"
- "Community: Join discussions, share your experiences"
- "Contributing: It's MIT licensed - PRs welcome"

**Call to Action** (Slide 43)
- "Try autopilot this week on a small feature. See how it feels to describe the goal and let the system orchestrate."
- "If you like it, share it with your team. OMC shines with real-world complexity."
- "Now, let's open for questions."

### Transition to Q&A
"What questions do you have? Anything I can clarify or elaborate on?"

---

## Common Q&A

Prepare answers for these likely questions:

### 1. "How much does it cost?"

**Answer:**
"OMC itself is completely free - it's MIT licensed open-source. What you pay for is the Claude API usage.

You need either:
- A Claude Pro subscription ($20/month) which includes API access
- Or a Claude Team subscription with API credits
- Or direct API access via Anthropic

The key cost benefit: OMC's smart model routing saves you 30-50% on token costs compared to manually using Claude. For example, simple searches use Haiku (super cheap), complex debugging uses Opus (expensive but necessary). Without OMC, everything might default to Opus.

Ecomode specifically optimizes for cost - in our benchmarks, it reduces costs by 40-60% compared to ultrawork mode while still completing the work effectively."

### 2. "Can I use it with other AI models?"

**Answer:**
"Currently OMC is designed specifically for Claude Code and leverages Claude's three model tiers - Haiku, Sonnet, and Opus.

The architecture relies on Claude's specific capabilities for the multi-agent orchestration. We don't support GPT-4, Gemini, or other models at this time.

That said, it's open-source. If there's community interest in adapting it to other providers, we'd welcome contributions. The core orchestration logic could theoretically work with any provider that offers multiple model tiers."

### 3. "How is this different from just using Claude Code?"

**Answer:**
"Great question. Without OMC, Claude Code gives you one very smart generalist assistant. You tell it every step: 'search for this, analyze that, now implement this, now test that.'

With OMC, you get 28 specialized agents orchestrated automatically. You state the goal - 'build authentication' - and OMC:
- Automatically explores your codebase for patterns
- Plans the implementation
- Parallelizes execution across multiple agents
- Runs verification and testing
- Persists until completion

It's the difference between hiring one person who does everything sequentially versus coordinating a specialized team working in parallel.

Real-world impact: Tasks that took 30 minutes of back-and-forth with Claude Code now take 5 minutes of autonomous execution with OMC."

### 4. "What about security? Is my code safe?"

**Answer:**
"OMC runs entirely locally via Claude Code. Your code never leaves your machine except through the normal Claude API calls that you'd be making anyway.

Additionally, OMC includes a security-reviewer agent that can audit code for common vulnerabilities. You can invoke it explicitly: '/pipeline security' runs a security audit pipeline.

The notepad wisdom system stores data locally in `.omc/notepads/`. Nothing is sent to external servers.

For maximum security, you can review the code - it's fully open-source on GitHub. Every agent prompt is visible."

### 5. "Can I customize the agents?"

**Answer:**
"Absolutely. Agent customization is a first-class feature.

Place custom agent definitions in `~/.claude/agents/{agent-name}.md` and they'll override the defaults.

For example, if you want a specialized Python testing agent:
```markdown
# ~/.claude/agents/pytest-specialist.md
You are an expert in pytest and Python testing best practices.
Focus on: fixtures, parametrization, mocking with pytest-mock.
```

Then invoke: `Task(subagent_type="oh-my-claudecode:pytest-specialist")`

You can also customize execution modes, delegation categories, and model routing rules via the config file at `~/.claude/.omc-config.json`.

Power users go deep on customization. Casual users never need to touch it."

### 6. "Does it work with any programming language?"

**Answer:**
"Yes. OMC works with any language that Claude Code supports - which is basically all mainstream languages.

Some agents have special optimizations:
- build-fixer has deep TypeScript integration
- tdd-guide understands pytest, jest, go test, cargo test
- designer agents understand React, Vue, Svelte

But the core orchestration is language-agnostic. I've used it successfully with TypeScript, Python, Go, Rust, Java, and even Bash scripts.

The codebase exploration works universally since it uses grep, glob, and LSP under the hood."

### 7. "How do I know which mode to use?"

**Answer:**
"Honestly? You don't need to think about it. Just describe what you want in natural language and OMC auto-detects the right mode.

But if you want to be explicit:
- NEW FEATURE, GREENFIELD: autopilot or ultrapilot
- PARALLEL FIXES: ultrawork (speed) or  (cost)
- BATCH HOMOGENEOUS TASKS: swarm
- SEQUENTIAL WORKFLOW: pipeline
- MUST COMPLETE: ralph

The magic keywords make it easy:
- 'build me a...' → autopilot
- 'fast parallel' → ultrawork
- 'efficient batch' → 
- 'don't stop' → ralph

After a week of use, you'll develop intuition. But day one? Just describe the goal naturally."

### 8. "What happens if a demo fails?"

**Answer:**
"That's what ralph mode is for! Ralph literally won't stop until it succeeds.

But more seriously - OMC has built-in verification at multiple levels:
- Build verification (does it compile?)
- Test verification (do tests pass?)
- Lint verification (does it pass linting?)
- Architect verification (does it actually solve the problem?)

If any verification fails, it enters a fix-verify loop automatically.

In practice, failures happen - maybe a test fails, maybe there's a linting error. OMC catches these and fixes them before claiming completion.

The Architect verification step is the final check - a separate Opus-powered agent reviews the work and either approves or sends it back for revision."

### 9. "Can I run this in CI/CD?"

**Answer:**
"OMC is designed for interactive development, not CI/CD automation.

The planning interviews require human input. The execution modes assume iterative refinement. The architect verification is designed for development-time quality checks.

For CI/CD, you'd use Claude Code's built-in capabilities or traditional CI tools.

That said, some teams use OMC-generated tests in their CI pipeline. The tests themselves are standard - jest, pytest, etc. - they just happened to be generated via OMC.

There's been interest in a 'CI mode' that's fully non-interactive. If that's something you need, open a GitHub issue - we prioritize based on user demand."

### 10. "What's the learning curve?"

**Answer:**
"Zero. Genuinely zero.

The entire design philosophy is 'natural language first.' You don't need to learn commands, agents, or modes.

Day one: 'autopilot: build a todo app'
That's it. Everything else is automatic.

The magic keywords (ulw, eco, ralplan) are shortcuts for power users. You can be productive for months without learning them.

Compare this to traditional tools:
- Terraform: Days to learn HCL syntax
- Kubernetes: Weeks to understand pods, deployments, services
- Even git: Hours to understand branching, merging, rebasing

OMC: Literally zero learning time. If you can describe what you want in English, you can use OMC.

The learning comes later - understanding WHEN to use ultrawork vs pipeline, WHICH agent is best for what. But that's optimization, not prerequisites."

---

## Presentation Tips

### Energy Management
- **HIGH ENERGY** during execution modes section (slides 9-23) - this is your core content
- **MODERATE ENERGY** during architecture and agent system - don't overwhelm
- **PEAK ENERGY** during demos - this is where you win hearts and minds
- **CALM ENERGY** during Q&A - project confidence and expertise

### Narration During Demos
- NEVER let silence happen. If demo is running, talk through what's happening
- Point to specific parts of the screen: "See this line in the HUD? That's the architect agent reviewing the code."
- If demo is slow: "This would normally be faster, but we're on conference WiFi. Let me show you a recorded version."
- Have cursor highlights or screen annotations ready to draw attention

### Reading the Room
- **Confused faces during architecture (slide 6)?** Stop and ask: "Is the flow clear? Should I walk through an example?"
- **Excited faces during demos?** Extend demo time by borrowing from closing
- **Checked-out faces?** Speed up, add a joke, or ask an engaging question
- **Lots of questions during modes section?** You're doing great, take them

### The "Before vs After" Slide (Slide 5)
This is your MOST IMPORTANT persuasion tool. Nail it.

**Script it word-for-word:**
"Let me show you the mental model shift. BEFORE OMC: [read the before section slowly]. You're the micromanager. AFTER OMC: [read the after section with rising energy]. You're the product owner. This isn't a 10% improvement - this is a complete paradigm shift."

### Time Management
- **Ahead 5+ minutes?** Extend Q&A, add extra demo, elaborate on agent system
- **Behind 5+ minutes?** Cut demo 4 or 5, shorten Q&A prep
- **Ahead 2-4 minutes?** Take extra questions during demos
- **Behind 2-4 minutes?** Skip a preset in pipeline demo, shorten cost analytics

### Common Pitfalls to Avoid
- Don't get bogged down in technical implementation details unless specifically asked
- Don't spend too long on any single mode - budget 4 minutes each strictly
- Don't let Q&A during demos derail the schedule - "Great question, let me finish this demo and come back to it"
- Don't claim perfection - acknowledge limitations ("Not ideal for CI/CD", "Ecomode trades speed for cost")

### Handling Technical Difficulties
- **Demo fails?** "Let me show you a recorded successful run" [have recordings ready]
- **API down?** "Perfect timing to show you the recorded demos at full speed"
- **Laptop freezes?** "While this restarts, let me take questions on what we've covered"
- **Wrong slide?** Don't apologize, just navigate: "Let me jump to the right slide..."

### Building Rapport
- Use "you" and "your": "Your AI assistant", "your codebase", "your workflow"
- Acknowledge pain points: "We've all been there"
- Share personal anecdotes: "I recently used autopilot to..."
- Avoid jargon unless explaining it: "LSP - that's Language Server Protocol"

### The Final Impression
Your last 30 seconds set the memory. End with energy:

"OMC transforms AI-assisted development from interactive tutoring to autonomous execution. It's free, it's open-source, and it's ready for you to try today. Install it this week, build something with autopilot, and see how it feels to conduct the orchestra instead of playing every instrument. Thank you - let's take your questions."

[Hold for applause, then open for Q&A]

---

## Emergency Backup Plans

### If Demos Completely Fail
"I had demos prepared, but Murphy's Law strikes. Instead, let me walk you through this recorded session where I built a complete CRUD API in 3 minutes using ultrapilot."

[Have high-quality recordings ready on USB drive]

### If Running Way Over Time
Skip to: Slide 34 (Developer Experience summary), Slide 38 (Quick start), Slide 41 (Closing)
Total time saved: ~10 minutes

### If Running Way Under Time
Extend demos:
- "Let me show you one more - swarm mode on a batch of linting errors"
- "Anyone want to suggest a scenario? I'll do it live."
- Extended Q&A with deep-dive answers

### If Audience Is Highly Technical
- Spend more time on architecture (slide 6)
- Deep dive into task decomposition in ultrapilot
- Show the actual agent prompts from the codebase
- Discuss the state management and coordination protocols

### If Audience Is Non-Technical
- Spend less time on agent system (slides 24-28)
- More time on analogies and before/after comparisons
- Focus on autopilot demo (skip technical modes)
- Emphasize zero learning curve and natural language

---

## Post-Presentation Checklist

After the seminar:

- [ ] Share slides and recording link
- [ ] Post GitHub repo link in chat/email
- [ ] Collect email addresses for follow-up resources
- [ ] Note common questions for FAQ document
- [ ] Get feedback forms completed
- [ ] Follow up with anyone who seemed particularly interested (potential contributors/power users)

---

## Final Notes

**Remember:**
- You're not selling a product, you're sharing a paradigm shift
- Demos win hearts, architecture wins minds
- Energy is contagious - if you're excited, they'll be excited
- The "before vs after" comparison is your strongest tool
- Natural language first - emphasize zero learning curve constantly

**Your Goal:**
By the end, every person should:
1. Understand the conductor vs performer mental model
2. Know which execution mode they'd try first
3. Feel confident they could install and use OMC today
4. Be excited about the paradigm shift from interactive to autonomous

**Your Success Metric:**
"How many people install OMC in the next week?"

Good luck. You've got this.

---

*These notes are optimized for a 60-minute seminar with live demos. Adjust timing based on audience engagement and technical difficulties. Always prioritize the demos - seeing is believing.*
