# Screenshot Guide for OMC Seminar

This guide documents all screenshots needed for the seminar presentation, with detailed capture instructions and ASCII mockups that can serve as standalone visuals.

## Quick Reference

| Screenshot | Slide | Priority | Capture Method |
|------------|-------|----------|----------------|
| `autopilot-phases.png` | 10 | HIGH | Live capture |
| `before-after.png` | 6 | HIGH | Split terminal |
| `hud-statusline.png` | 35 | HIGH | Live capture |
| `parallel-agents.png` | 30 | HIGH | Live capture |
| `ralph-persistence.png` | 33 | MEDIUM | Live capture |
| `pipeline-flow.png` | 19 | MEDIUM | Terminal + logs |
| `planning-interview.png` | 32 | MEDIUM | Live capture |
| `swarm-agents.png` | 16 | MEDIUM | Live capture |
| `agent-tiers.png` | 25 | LOW | Create diagram |
| `-savings.png` | 22 | LOW | Mock data viz |

---

## Required Screenshots

### 1. `autopilot-phases.png` (Slide 10)

**Description:** Terminal showing autopilot progressing through all 5 phases with phase transitions, agent activations, and completion status.

**Capture Instructions:**
1. Open terminal with dark theme (Dracula or similar)
2. Set window size to 100x40 for readability
3. Run: `claude` (start Claude Code)
4. Type: `autopilot: build a simple REST API for bookstore inventory`
5. Wait for completion (3-5 minutes)
6. Scroll to show all phases in one screen if possible
7. Capture full terminal window

**Alternative Commands:**
```bash
# Quick demo version
autopilot: create a CLI calculator with add/subtract/multiply

# More impressive but longer
autopilot: build a React dashboard with user authentication
```

**ASCII Mockup:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ claude @ oh-my-claudecode                                    [Phase 4/5] ⚡ │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ > autopilot: build a REST API for bookstore inventory                       │
│                                                                             │
│ I'm activating **autopilot** for full autonomous execution from idea to    │
│ working, tested code.                                                       │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ ▶ Phase 0: Expansion                                             [2m 15s]  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│   [analyst:opus] Analyzing requirements and extracting key needs...        │
│   ✓ Identified 3 core entities: Book, Author, Inventory                    │
│   ✓ Extracted 8 functional requirements                                    │
│   ✓ Identified constraints: RESTful, JSON, validation                      │
│                                                                             │
│   [architect:opus] Creating technical specification...                     │
│   ✓ Proposed stack: Node.js + Express + SQLite                             │
│   ✓ Defined API endpoints (12 routes)                                      │
│   ✓ Database schema designed (3 tables)                                    │
│                                                                             │
│   📄 Output: .omc/autopilot/spec.md (428 lines)                            │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ ▶ Phase 1: Planning                                              [1m 48s]  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│   [architect:opus] Designing implementation plan...                        │
│   ✓ Created 15 implementation tasks                                        │
│   ✓ Identified dependencies and execution order                            │
│   ✓ Estimated effort: 12 subtasks (parallelizable: 8)                     │
│                                                                             │
│   [critic:opus] Reviewing implementation plan...                           │
│   ✓ Plan structure: APPROVED                                               │
│   ✓ Technical feasibility: APPROVED                                        │
│   ✓ Risk assessment: LOW                                                   │
│                                                                             │
│   📄 Output: .omc/plans/autopilot-impl.md (23 tasks)                       │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ ▶ Phase 2: Execution                                             [4m 32s]  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│   Parallel execution: 5 concurrent workers                                 │
│                                                                             │
│   [executor:sonnet]     ✓ Implemented routes/books.ts (145 lines)          │
│   [executor:sonnet]     ✓ Implemented routes/authors.ts (112 lines)        │
│   [executor-low:haiku]  ✓ Created package.json                             │
│   [executor-low:haiku]  ✓ Created tsconfig.json                            │
│   [executor:sonnet]     ✓ Implemented models/database.ts (203 lines)       │
│   [executor-low:haiku]  ✓ Created .env.example                             │
│   [executor:sonnet]     ✓ Implemented middleware/validation.ts             │
│   [executor-high:opus]  ✓ Implemented server.ts with error handling        │
│                                                                             │
│   Progress: 23/23 tasks completed ████████████████████████████ 100%        │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ ▶ Phase 3: QA                                                    [3m 05s]  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│   Cycle 1:                                                                 │
│     [build-fixer:sonnet]  ✓ BUILD: tsc compilation successful              │
│     [qa-tester:sonnet]    ✓ LINT: 0 errors, 0 warnings                     │
│     [qa-tester:sonnet]    ✓ TEST: 12/12 passed (87% coverage)              │
│                                                                             │
│   All QA checks passed on first cycle. No fixes needed.                    │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ ▶ Phase 4: Validation                                            [2m 10s]  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│   [architect:opus] Functional completeness review...                       │
│   ✓ All 12 API endpoints implemented and tested                            │
│   ✓ Database schema matches specification                                  │
│   ✓ Error handling comprehensive                                           │
│   ✓ Input validation present on all routes                                 │
│   Verdict: APPROVED                                                        │
│                                                                             │
│   [security-reviewer:opus] Security vulnerability assessment...            │
│   ✓ SQL injection: Protected (parameterized queries)                       │
│   ✓ Input validation: Present on all endpoints                             │
│   ✓ Error messages: No sensitive data leakage                              │
│   ✓ Dependencies: No known vulnerabilities                                 │
│   Verdict: APPROVED                                                        │
│                                                                             │
│   [code-reviewer:opus] Code quality review...                              │
│   ✓ Code structure: Well-organized, follows REST principles                │
│   ✓ TypeScript usage: Proper types, no any abuse                           │
│   ✓ Error handling: Consistent middleware pattern                          │
│   ✓ Test coverage: 87% (exceeds 80% threshold)                             │
│   Verdict: APPROVED                                                        │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│ ✅ Autopilot complete. All phases passed.                                  │
│                                                                             │
│ Summary:                                                                   │
│   • Total time: 13m 50s                                                    │
│   • Files created: 18                                                      │
│   • Lines of code: 1,247                                                   │
│   • Tests: 12 passing                                                      │
│   • QA cycles: 1                                                           │
│   • Validations: 3/3 approved                                              │
│                                                                             │
│ To start the server: npm install && npm run dev                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 2. `before-after.png` (Slide 6)

**Description:** Split-screen comparison showing manual Claude Code usage on left vs. OMC orchestrated on right, demonstrating the difference in workflow.

**Capture Instructions:**
1. Use `tmux` or terminal split feature
2. Left pane: Manual workflow
   ```bash
   # In left pane
   claude
   > Can you implement user authentication?
   > (wait for response)
   > Now add validation...
   > (wait for response)
   > Can you test this?
   > (wait for response)
   ```
3. Right pane: OMC workflow
   ```bash
   # In right pane
   claude
   > autopilot: implement user authentication with validation and tests
   # (watch it run automatically)
   ```
4. Capture when both show contrasting states

**ASCII Mockup:**
```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│ BEFORE: Manual Claude Code          │ AFTER: OMC Orchestration            │
├─────────────────────────────────────┼─────────────────────────────────────┤
│ > Can you implement user auth?      │ > autopilot: implement user auth    │
│                                     │   with validation and tests         │
│ I'll create authentication logic... │                                     │
│                                     │ Activating autopilot...             │
│ [Creates auth.ts]                   │                                     │
│ Done.                               │ ▶ Phase 0: Expansion                │
│                                     │   [analyst] Extracting reqs...      │
│ > Great! Now add input validation   │   [architect] Creating spec...      │
│                                     │                                     │
│ I'll add validation middleware...   │ ▶ Phase 1: Planning                 │
│                                     │   [architect] Designing plan...     │
│ [Updates auth.ts]                   │   [critic] Reviewing... APPROVED    │
│ Done.                               │                                     │
│                                     │ ▶ Phase 2: Execution                │
│ > Can you write tests for this?     │   [executor] auth.ts                │
│                                     │   [executor] validation.ts          │
│ I'll create test cases...           │   [executor-low] test setup         │
│                                     │   [designer] error pages            │
│ [Creates auth.test.ts]              │                                     │
│ Done.                               │ ▶ Phase 3: QA                       │
│                                     │   BUILD: PASS                       │
│ > Can you run the tests?            │   LINT: PASS                        │
│                                     │   TEST: 15/15 PASS                  │
│ (You need to run: npm test)         │                                     │
│                                     │ ▶ Phase 4: Validation               │
│ > npm test                          │   [architect] APPROVED              │
│   FAIL auth.test.ts                 │   [security-reviewer] APPROVED      │
│   ● missing hash comparison         │   [code-reviewer] APPROVED          │
│                                     │                                     │
│ > Can you fix the failing test?     │ ✅ Complete. All phases passed.     │
│                                     │                                     │
│ I'll update the hash logic...       │ Created 8 files, 15 tests passing   │
│                                     │                                     │
│ [Updates auth.ts]                   │ Time: 8m 42s (hands-off)            │
│ Try running tests again.            │                                     │
│                                     │                                     │
│ > npm test                          │                                     │
│   PASS auth.test.ts                 │                                     │
│   ✓ All tests passing               │                                     │
│                                     │                                     │
│ ────────────────────────────────────┼─────────────────────────────────────┤
│ Time: ~25 minutes                   │ Time: ~9 minutes                    │
│ Your input: 6 prompts               │ Your input: 1 prompt                │
│ Context switches: High              │ Context switches: None              │
│ Manual verification: You run tests  │ Automatic verification: Built-in    │
│ Debugging: Manual prompting         │ Debugging: Auto-retry in QA phase   │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Alternative Creation:**
Create as a slide graphic using:
- Two terminal screenshots side-by-side
- Arrows showing interaction points
- Timeline at bottom showing time difference
- Annotations highlighting key differences

---

### 3. `hud-statusline.png` (Slide 35)

**Description:** HUD statusline showing active agents, todo progress, token usage, and context window status in real-time.

**Capture Instructions:**
1. Ensure HUD is installed: `claude` then `/oh-my-claudecode:hud setup`
2. Start a task with multiple agents:
   ```
   ultrawork: refactor the authentication system
   ```
3. While agents are running, capture the statusline at the top
4. Best captured mid-execution when multiple agents are active

**ASCII Mockup:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🎯 OMC HUD │ Agents: 3 active │ Todos: 8/15 done │ Tokens: 145K/200K │ 🟢   │
│ Active: [executor:sonnet] [executor-low:haiku] [architect:opus]            │
│ Current: Refactoring auth middleware... │ Context: 72% │ Cost: $1.23        │
└─────────────────────────────────────────────────────────────────────────────┘
│                                                                             │
│ [executor:sonnet] Refactoring src/auth/middleware.ts...                     │
│ ✓ Extracted validation logic                                               │
│ ✓ Added error handling                                                     │
│ ⚙ Running tests...                                                         │
│                                                                             │
│ [executor-low:haiku] Updating configuration files...                        │
│ ✓ Updated .env.example                                                     │
│ ✓ Updated README.md                                                        │
│                                                                             │
│ [architect:opus] Reviewing architecture changes...                          │
│ ⚙ Analyzing dependency graph...                                            │
│                                                                             │
```

**Detailed Statusline Elements:**
```
┌────┬──────────┬─────────────┬──────────────┬────────┐
│ 🎯 │  Agents  │    Todos    │    Tokens    │ Status │
│ OMC│ 3 active │  8/15 done  │ 145K/200K    │  🟢    │
│ HUD│          │   (53%)     │   (73%)      │        │
└────┴──────────┴─────────────┴──────────────┴────────┘

Active Agents (hover for details):
  [executor:sonnet]        - Working on auth/middleware.ts
  [executor-low:haiku]     - Updating config files
  [architect:opus]         - Reviewing architecture

Context Window: ████████████████████░░░░░░░░ 72%

Cost This Session: $1.23
```

---

### 4. `parallel-agents.png` (Slide 30)

**Description:** Terminal showing ultrawork with multiple agents executing tasks simultaneously, with clear visual indication of parallel execution.

**Capture Instructions:**
1. Start ultrawork with a task that spawns multiple agents:
   ```
   ultrawork: fix all TypeScript errors in the src/ directory
   ```
2. Capture when you see multiple `[agent:model]` lines running concurrently
3. Wait for the "parallel execution" indicator

**ASCII Mockup:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ > ultrawork: fix all TypeScript errors in src/                             │
│                                                                             │
│ I'm activating **ultrawork** for maximum parallel execution.               │
│                                                                             │
│ [explore:haiku] Scanning for TypeScript errors...                          │
│ ✓ Found 23 errors across 8 files                                           │
│                                                                             │
│ Spawning parallel workers: 5 agents                                        │
│                                                                             │
│ ┌───────────────────────────────────────────────────────────────────────┐  │
│ │ Parallel Execution: 5 concurrent agents                               │  │
│ ├───────────────────────────────────────────────────────────────────────┤  │
│ │                                                                       │  │
│ │ [executor:sonnet]     ⚙ src/auth/login.ts (7 errors)                 │  │
│ │                       ✓ Fixed missing return type                     │  │
│ │                       ✓ Fixed undefined variable                      │  │
│ │                       ⚙ Fixing async/await issues...                 │  │
│ │                                                                       │  │
│ │ [executor-low:haiku]  ⚙ src/utils/helpers.ts (3 errors)              │  │
│ │                       ✓ Fixed implicit any                            │  │
│ │                       ✓ Added type annotations                        │  │
│ │                       ✓ Complete (3/3 fixed)                          │  │
│ │                                                                       │  │
│ │ [executor:sonnet]     ⚙ src/models/user.ts (5 errors)                │  │
│ │                       ✓ Fixed interface property                      │  │
│ │                       ⚙ Adding missing methods...                     │  │
│ │                                                                       │  │
│ │ [executor-low:haiku]  ⚙ src/config/index.ts (2 errors)               │  │
│ │                       ✓ Fixed module import                           │  │
│ │                       ✓ Complete (2/2 fixed)                          │  │
│ │                                                                       │  │
│ │ [executor:sonnet]     ⚙ src/routes/api.ts (6 errors)                 │  │
│ │                       ✓ Fixed middleware types                        │  │
│ │                       ✓ Added request/response types                  │  │
│ │                       ⚙ Fixing handler signatures...                 │  │
│ │                                                                       │  │
│ └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│ Progress: 12/23 errors fixed ████████████░░░░░░░░░░░░░░░░░ 52%             │
│                                                                             │
│ ┌───────────────────────────────────────────────────────────────────────┐  │
│ │ Completed Workers:                                                    │  │
│ │ ✓ [executor-low:haiku] src/utils/helpers.ts (3 errors fixed)         │  │
│ │ ✓ [executor-low:haiku] src/config/index.ts (2 errors fixed)          │  │
│ └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│ ┌───────────────────────────────────────────────────────────────────────┐  │
│ │ Active Workers: 3                                                     │  │
│ │ ⚙ [executor:sonnet] src/auth/login.ts (4/7 done)                     │  │
│ │ ⚙ [executor:sonnet] src/models/user.ts (2/5 done)                    │  │
│ │ ⚙ [executor:sonnet] src/routes/api.ts (3/6 done)                     │  │
│ └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│ Estimated completion: 2m 15s                                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Alternative with Timeline:**
```
Time →
  0s ┤ [explore:haiku] Scanning...
  5s ┤ ┌─ [executor:sonnet] ──────────────────┐
     │ ├─ [executor-low:haiku] ───┐           │
     │ ├─ [executor:sonnet] ──────────────┐   │
     │ ├─ [executor-low:haiku] ─────┐     │   │
     │ └─ [executor:sonnet] ───────────────────┘
     │                                  └──┘└──┘└─┘
180s ┤ All complete
```

---

### 5. `ralph-persistence.png` (Slide 33)

**Description:** Terminal showing ralph detecting an error, self-correcting, and continuing until successful.

**Capture Instructions:**
1. Start ralph with a task that might have issues:
   ```
   ralph: implement JWT authentication with refresh tokens
   ```
2. Watch for error detection and auto-correction
3. Capture the retry loop

**ASCII Mockup:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ > ralph: implement JWT authentication with refresh tokens                   │
│                                                                             │
│ I'm activating **ralph-loop** to ensure complete, verified execution.      │
│                                                                             │
│ ═══ Ralph Iteration 1 ═══                                                  │
│                                                                             │
│ [executor:sonnet] Implementing JWT authentication...                        │
│ ✓ Created src/auth/jwt.ts                                                  │
│ ✓ Created src/auth/refresh.ts                                              │
│ ✓ Added middleware src/middleware/auth.ts                                  │
│                                                                             │
│ [build-fixer:sonnet] Running build verification...                          │
│ ✗ BUILD FAILED                                                              │
│   Error: TS2304 - Cannot find name 'jwt' in src/auth/jwt.ts:15             │
│   Error: TS2305 - Module 'jsonwebtoken' has no exported member 'verify'    │
│                                                                             │
│ 🔄 Ralph detected issues. Initiating correction...                          │
│                                                                             │
│ ═══ Ralph Iteration 2 ═══                                                  │
│                                                                             │
│ [architect:opus] Analyzing build failures...                                │
│ Root cause: Missing jsonwebtoken dependency and incorrect import            │
│ Recommended fixes:                                                          │
│   1. Add jsonwebtoken to package.json                                      │
│   2. Fix import statement in jwt.ts                                        │
│   3. Add @types/jsonwebtoken for TypeScript                                │
│                                                                             │
│ [executor:sonnet] Applying fixes...                                         │
│ ✓ Updated package.json with jsonwebtoken@9.0.2                             │
│ ✓ Updated package.json with @types/jsonwebtoken@9.0.5                      │
│ ✓ Fixed import in src/auth/jwt.ts                                          │
│                                                                             │
│ [build-fixer:sonnet] Running build verification...                          │
│ ✗ BUILD FAILED                                                              │
│   Warning: npm install needed to resolve dependencies                       │
│                                                                             │
│ 🔄 Ralph continuing...                                                       │
│                                                                             │
│ ═══ Ralph Iteration 3 ═══                                                  │
│                                                                             │
│ [executor-low:haiku] Installing dependencies...                             │
│ $ npm install                                                               │
│ ✓ jsonwebtoken@9.0.2 installed                                             │
│ ✓ @types/jsonwebtoken@9.0.5 installed                                      │
│                                                                             │
│ [build-fixer:sonnet] Running build verification...                          │
│ ✓ BUILD PASSED                                                              │
│                                                                             │
│ [qa-tester:sonnet] Running tests...                                         │
│ ✗ TEST FAILED: 2/8 tests failing                                           │
│   ✗ should generate valid JWT token                                        │
│     Expected 3 segments in JWT, received 2                                 │
│   ✗ should refresh expired token                                           │
│     Error: Token verification failed                                        │
│                                                                             │
│ 🔄 Ralph detected test failures. Analyzing...                               │
│                                                                             │
│ ═══ Ralph Iteration 4 ═══                                                  │
│                                                                             │
│ [architect:opus] Analyzing test failures...                                 │
│ Root cause: JWT signing missing algorithm specification                     │
│                                                                             │
│ [executor:sonnet] Fixing JWT signing logic...                               │
│ ✓ Added algorithm: 'HS256' to jwt.sign() options                           │
│ ✓ Added algorithm: 'HS256' to jwt.verify() options                         │
│                                                                             │
│ [qa-tester:sonnet] Running tests...                                         │
│ ✓ TEST PASSED: 8/8 tests passing                                           │
│                                                                             │
│ [architect:opus] Final verification...                                      │
│ ✓ All requirements met                                                     │
│ ✓ Build passes                                                             │
│ ✓ Tests pass (8/8)                                                         │
│ ✓ Security review: JWT implementation follows best practices               │
│                                                                             │
│ ✅ Ralph complete. Task verified successful after 4 iterations.             │
│                                                                             │
│ Summary:                                                                   │
│   • Iterations: 4                                                          │
│   • Auto-corrections: 3                                                    │
│   • Issues resolved: Missing deps, import errors, JWT algorithm            │
│   • Final status: All verifications passed                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 6. `pipeline-flow.png` (Slide 19)

**Description:** Terminal showing pipeline execution with sequential agent handoff and data passing between stages.

**Capture Instructions:**
1. Use a pipeline preset or custom pipeline:
   ```
   /oh-my-claudecode:pipeline review "analyze the authentication system"
   ```
2. Capture showing each stage completing and passing data to next
3. Alternative: Check `.omc/logs/pipeline.log` for formatted output

**ASCII Mockup:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ > /pipeline review "analyze the authentication system"                     │
│                                                                             │
│ Activating pipeline mode with preset: review                               │
│ Stages: explore → architect → critic → executor                            │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ ▶ Stage 1/4: explore (haiku)                                    [45s]      │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│ Task: Map authentication system components                                 │
│                                                                             │
│ [explore:haiku] Searching codebase...                                       │
│ ✓ Found 8 authentication-related files                                     │
│ ✓ Identified entry points: src/auth/login.ts, src/auth/register.ts        │
│ ✓ Mapped dependencies: 12 modules                                          │
│ ✓ Located tests: 6 test files                                              │
│                                                                             │
│ Output: Component map with 8 files, 12 dependencies                        │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ ▶ Stage 2/4: architect (opus)                                   [2m 15s]   │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│ Task: Analyze architecture and identify issues                             │
│ Input: Component map from Stage 1                                          │
│                                                                             │
│ [architect:opus] Analyzing authentication architecture...                   │
│ ✓ Reviewed 8 components                                                    │
│ ✓ Analyzed data flow                                                       │
│ ✓ Checked security patterns                                                │
│                                                                             │
│ Findings:                                                                  │
│   ⚠ Issue: Password hashing uses weak algorithm (MD5)                      │
│   ⚠ Issue: Session tokens not validated on refresh                         │
│   ⚠ Issue: Rate limiting missing on login endpoint                         │
│   ✓ Good: JWT implementation follows best practices                        │
│   ✓ Good: Input validation comprehensive                                   │
│                                                                             │
│ Output: Analysis report with 3 critical issues, 2 strengths                │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ ▶ Stage 3/4: critic (opus)                                      [1m 30s]   │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│ Task: Review findings and prioritize fixes                                 │
│ Input: Analysis report from Stage 2                                        │
│                                                                             │
│ [critic:opus] Reviewing analysis and recommendations...                     │
│                                                                             │
│ Critical Priority:                                                         │
│   1. Replace MD5 with bcrypt (Security vulnerability - HIGH)               │
│   2. Add session token validation (Auth bypass risk - HIGH)                │
│                                                                             │
│ Medium Priority:                                                           │
│   3. Implement rate limiting (DoS protection - MEDIUM)                     │
│                                                                             │
│ Analysis Quality: APPROVED                                                 │
│ Recommendations: APPROVED with priority ordering                            │
│                                                                             │
│ Output: Prioritized fix plan with 3 tasks                                  │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ ▶ Stage 4/4: executor (sonnet)                                  [3m 45s]   │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│ Task: Implement fixes in priority order                                    │
│ Input: Fix plan from Stage 3                                               │
│                                                                             │
│ [executor:sonnet] Implementing fixes...                                     │
│                                                                             │
│ Fix 1/3: Replace MD5 with bcrypt                                           │
│   ✓ Added bcrypt dependency                                                │
│   ✓ Updated src/auth/hash.ts to use bcrypt                                 │
│   ✓ Updated all hash usage points (4 files)                                │
│   ✓ Added tests for new hashing                                            │
│                                                                             │
│ Fix 2/3: Add session token validation                                      │
│   ✓ Implemented token validation in src/auth/session.ts                    │
│   ✓ Added validation middleware                                            │
│   ✓ Added tests for validation logic                                       │
│                                                                             │
│ Fix 3/3: Implement rate limiting                                           │
│   ✓ Added express-rate-limit dependency                                    │
│   ✓ Configured rate limiter in src/middleware/rateLimit.ts                 │
│   ✓ Applied to login/register endpoints                                    │
│   ✓ Added tests for rate limiting                                          │
│                                                                             │
│ Verification:                                                              │
│   ✓ Build passes                                                           │
│   ✓ All tests pass (18/18)                                                 │
│   ✓ Security scan clean                                                    │
│                                                                             │
│ Output: All fixes implemented and verified                                 │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│ ✅ Pipeline complete. All stages passed.                                    │
│                                                                             │
│ Summary:                                                                   │
│   • Total time: 8m 15s                                                     │
│   • Stages: 4/4 completed                                                  │
│   • Issues found: 3 (all fixed)                                            │
│   • Files changed: 7                                                       │
│   • Tests added: 9                                                         │
│                                                                             │
│ Stage breakdown:                                                           │
│   explore   ━━━━━━━ 45s                                                    │
│   architect ━━━━━━━━━━━━━━━━━━━━ 2m 15s                                    │
│   critic    ━━━━━━━━━━━━━ 1m 30s                                           │
│   executor  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 3m 45s                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Flow Diagram Alternative:**
```
┌─────────┐
│ explore │ Finds 8 files, 12 deps
└────┬────┘
     │ passes component map
     ▼
┌─────────┐
│architect│ Analyzes, finds 3 issues
└────┬────┘
     │ passes analysis report
     ▼
┌─────────┐
│ critic  │ Prioritizes fixes
└────┬────┘
     │ passes fix plan
     ▼
┌─────────┐
│executor │ Implements all fixes
└─────────┘
     │
     ▼
   Done!
```

---

### 7. `planning-interview.png` (Slide 32)

**Description:** Interactive planning session using AskUserQuestion tool with clickable options.

**Capture Instructions:**
1. Start planning with vague request:
   ```
   plan: I want to improve the user experience
   ```
2. Capture the AskUserQuestion UI when it appears
3. Should show question + clickable options

**ASCII Mockup:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ > plan: I want to improve the user experience                              │
│                                                                             │
│ I'm starting a planning session to understand your requirements.           │
│                                                                             │
│ [explore:haiku] Gathering context about current UX...                       │
│ ✓ Found 14 UI components                                                   │
│ ✓ Identified 3 user flows                                                  │
│ ✓ Located 8 pages/views                                                    │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│ ❓ Question 1 of 4                                                          │
│                                                                             │
│ Which area of user experience would you like to focus on?                  │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────┐   │
│ │ [ A ] Performance - faster page loads, smoother interactions        │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────┐   │
│ │ [ B ] Visual Design - modernize UI, improve aesthetics              │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────┐   │
│ │ [ C ] Usability - simplify workflows, reduce clicks                 │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────┐   │
│ │ [ D ] Accessibility - screen reader support, keyboard nav           │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────┐   │
│ │ [ E ] Mobile Experience - responsive design, touch optimization     │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────┐   │
│ │ [ F ] All of the above                                               │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ Type A-F or click an option above                                          │
│                                                                             │
│ >                                                                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**After User Selection:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ > C                                                                         │
│                                                                             │
│ ✓ Focus: Usability - simplify workflows, reduce clicks                     │
│                                                                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                             │
│ ❓ Question 2 of 4                                                          │
│                                                                             │
│ I've identified these potential usability improvements:                    │
│                                                                             │
│ • Login flow: 5 steps, could reduce to 2 steps                             │
│ • Dashboard: 8 clicks to reach common features, could reduce to 2          │
│ • Settings: nested 3 levels deep, could flatten structure                  │
│                                                                             │
│ Which should be the highest priority?                                      │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────┐   │
│ │ [ A ] Simplify login flow (affects all users daily)                 │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────┐   │
│ │ [ B ] Streamline dashboard (high-frequency actions)                 │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────┐   │
│ │ [ C ] Flatten settings structure (occasional use)                   │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────┐   │
│ │ [ D ] Do all three in order of impact                               │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ >                                                                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 8. `swarm-agents.png` (Slide 16)

**Description:** Multiple swarm agents claiming tasks from shared pool with atomic operations.

**Capture Instructions:**
1. Start swarm mode:
   ```
   /oh-my-claudecode:swarm 5:executor "implement all CRUD operations"
   ```
2. Capture when agents are actively claiming tasks
3. Check `.omc/state/swarm-tasks.json` for task status

**ASCII Mockup:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ > /swarm 5:executor "implement all CRUD operations"                        │
│                                                                             │
│ Activating swarm mode: 5 executor agents                                   │
│                                                                             │
│ [architect:opus] Breaking down into tasks...                                │
│ ✓ Created 12 parallelizable tasks                                          │
│ ✓ Initialized shared task pool                                             │
│                                                                             │
│ Spawning swarm workers...                                                  │
│                                                                             │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│ ┃ SWARM STATUS                                                           ┃ │
│ ┡━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┩ │
│ │ Tasks: 12 total │ 5 claimed │ 4 done │ 3 pending                       │ │
│ │ Workers: 5 active                                                      │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌──────────────────────────────────────────────────────────────────────┐   │
│ │ Worker 1 [executor:sonnet]                                           │   │
│ │ ✓ Claimed: task-03 - Create User                                     │   │
│ │ ⚙ Status: Implementing POST /users endpoint...                       │   │
│ │ Progress: 60% (validation done, saving to DB...)                     │   │
│ └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌──────────────────────────────────────────────────────────────────────┐   │
│ │ Worker 2 [executor:sonnet]                                           │   │
│ │ ✓ Claimed: task-05 - Read User                                       │   │
│ │ ⚙ Status: Implementing GET /users/:id endpoint...                    │   │
│ │ Progress: 40% (route created, adding validation...)                  │   │
│ └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌──────────────────────────────────────────────────────────────────────┐   │
│ │ Worker 3 [executor:sonnet]                                           │   │
│ │ ✓ Completed: task-01 - Create Product (2m 15s)                       │   │
│ │ ✓ Claimed: task-08 - Update Product                                  │   │
│ │ ⚙ Status: Implementing PUT /products/:id endpoint...                 │   │
│ │ Progress: 20% (starting implementation...)                            │   │
│ └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌──────────────────────────────────────────────────────────────────────┐   │
│ │ Worker 4 [executor:sonnet]                                           │   │
│ │ ✓ Completed: task-02 - Read Product (1m 45s)                         │   │
│ │ ✓ Completed: task-06 - Create Order (2m 30s)                         │   │
│ │ ⚙ Checking for next task...                                          │   │
│ │ ✓ Claimed: task-09 - Delete Order                                    │   │
│ │ ⚙ Status: Starting implementation...                                 │   │
│ └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌──────────────────────────────────────────────────────────────────────┐   │
│ │ Worker 5 [executor:sonnet]                                           │   │
│ │ ✓ Completed: task-04 - Update User (2m 10s)                          │   │
│ │ ✓ Claimed: task-07 - List Users with pagination                      │   │
│ │ ⚙ Status: Implementing GET /users endpoint with query params...      │   │
│ │ Progress: 75% (pagination logic complete, adding filters...)         │   │
│ └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌──────────────────────────────────────────────────────────────────────┐   │
│ │ COMPLETED TASKS (4)                                                  │   │
│ │ ✓ task-01: Create Product (2m 15s) - Worker 3                        │   │
│ │ ✓ task-02: Read Product (1m 45s) - Worker 4                          │   │
│ │ ✓ task-04: Update User (2m 10s) - Worker 5                           │   │
│ │ ✓ task-06: Create Order (2m 30s) - Worker 4                          │   │
│ └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌──────────────────────────────────────────────────────────────────────┐   │
│ │ PENDING TASKS (3)                                                    │   │
│ │ ⏸ task-10: Delete Product                                            │   │
│ │ ⏸ task-11: Delete User                                               │   │
│ │ ⏸ task-12: List Orders with filters                                  │   │
│ └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ Swarm efficiency: 4 tasks completed in parallel execution time of 2m 30s   │
│ (vs ~10m sequential)                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 9. `agent-tiers.png` (Slide 25)

**Description:** Diagram showing the 3-tier model routing system (LOW/MEDIUM/HIGH).

**Creation Method:** Create as diagram (not live capture).

**Tools:** Draw.io, Excalidraw, or ASCII art

**ASCII Mockup:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       OMC 3-Tier Model Routing                              │
└─────────────────────────────────────────────────────────────────────────────┘

                              Task Arrives
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │   Complexity Assessment      │
                    │   • Code size                │
                    │   • Reasoning depth          │
                    │   • Risk level               │
                    └──────────────┬───────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                │                  │                  │
                ▼                  ▼                  ▼
       ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
       │   LOW TIER     │ │  MEDIUM TIER   │ │   HIGH TIER    │
       │   (Haiku)      │ │   (Sonnet)     │ │    (Opus)      │
       ├────────────────┤ ├────────────────┤ ├────────────────┤
       │ • Quick lookup │ │ • Feature impl │ │ • Architecture │
       │ • Simple edits │ │ • Bug fixes    │ │ • Complex debug│
       │ • File search  │ │ • Testing      │ │ • Refactoring  │
       │ • Config files │ │ • UI work      │ │ • Security     │
       │                │ │ • Documentation│ │ • Planning     │
       ├────────────────┤ ├────────────────┤ ├────────────────┤
       │ Cost: $        │ │ Cost: $$       │ │ Cost: $$$      │
       │ Speed: Fast    │ │ Speed: Medium  │ │ Speed: Thorough│
       └────────────────┘ └────────────────┘ └────────────────┘

Agent Examples per Tier:

LOW TIER                 MEDIUM TIER              HIGH TIER
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ executor-low    │     │ executor        │     │ executor-high   │
│ explore         │     │ executor        │     │ explore-high    │
│ architect-low   │     │ architect-medium│     │ architect       │
│ designer-low    │     │ designer        │     │ designer-high   │
│ writer          │     │ researcher      │     │ planner         │
│ tdd-guide-low   │     │ vision          │     │ critic          │
│ sec-reviewer-low│     │ build-fixer     │     │ analyst         │
│                 │     │ tdd-guide       │     │ code-reviewer   │
│                 │     │ qa-tester       │     │ security-reviewer│
│                 │     │ scientist       │     │ scientist-high  │
└─────────────────┘     └─────────────────┘     └─────────────────┘

Token Savings Example:
┌──────────────────────────────────────────────────────────────────┐
│ Scenario: Fix 10 simple import errors                            │
│                                                                  │
│ ❌ All Opus:    10 × 50K tokens = 500K tokens = $15.00          │
│ ✓  Smart Route: 10 × 8K tokens  =  80K tokens = $0.40          │
│                                                                  │
│ Savings: 94.7% tokens, 97.3% cost                               │
└──────────────────────────────────────────────────────────────────┘

Selection Algorithm:
┌────────────────────────────────────────────────────────────────────┐
│ if (task.linesChanged > 100 || task.filesChanged > 5) {           │
│   return HIGH                                                      │
│ } else if (task.requiresReasoning || task.fileExists) {           │
│   return MEDIUM                                                    │
│ } else {                                                           │
│   return LOW                                                       │
│ }                                                                  │
└────────────────────────────────────────────────────────────────────┘
```

---

### 10. `-savings.png` (Slide 22)

**Description:** Visual comparison of token usage between standard execution and .

**Creation Method:** Create as data visualization (not live capture).

**ASCII Mockup:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Ecomode Token Savings Analysis                           │
│                   Fixing 20 TypeScript Errors Example                       │
└─────────────────────────────────────────────────────────────────────────────┘

STANDARD ULTRAWORK (No Smart Routing)
┌────────────────────────────────────────────────────────────────────────┐
│ 20 agents × Sonnet × 45K avg tokens = 900K tokens                     │
│                                                                        │
│ Agent 1  ████████████████████████████████████████████  45K            │
│ Agent 2  ████████████████████████████████████████████  45K            │
│ Agent 3  ████████████████████████████████████████████  45K            │
│ Agent 4  ████████████████████████████████████████████  45K            │
│ ...                                                                    │
│ Agent 20 ████████████████████████████████████████████  45K            │
│                                                                        │
│ Total: ████████████████████████████████████████ 900K tokens = $27.00  │
└────────────────────────────────────────────────────────────────────────┘

ECOMODE (Smart Model Routing)
┌────────────────────────────────────────────────────────────────────────┐
│ Mixed: 15 × Haiku (8K) + 4 × Sonnet (45K) + 1 × Opus (60K) = 300K    │
│                                                                        │
│ Simple fixes (Haiku):                                                  │
│ Agent 1  ████  8K                                                      │
│ Agent 2  ████  8K                                                      │
│ Agent 3  ████  8K                                                      │
│ ...                                                                    │
│ Agent 15 ████  8K                                                      │
│                                                                        │
│ Medium complexity (Sonnet):                                            │
│ Agent 16 ████████████████████████████████████████████  45K            │
│ Agent 17 ████████████████████████████████████████████  45K            │
│ Agent 18 ████████████████████████████████████████████  45K            │
│ Agent 19 ████████████████████████████████████████████  45K            │
│                                                                        │
│ Complex issue (Opus):                                                  │
│ Agent 20 ████████████████████████████████████████████████████  60K    │
│                                                                        │
│ Total: ███████████████ 300K tokens = $6.00                            │
└────────────────────────────────────────────────────────────────────────┘

SAVINGS BREAKDOWN
┌───────────────────────────────────────────────────────────┐
│ Token Reduction:  900K → 300K  (66.7% reduction)          │
│ Cost Reduction:   $27  → $6    (77.8% reduction)          │
│ Quality Impact:   No degradation (smart routing)          │
│ Time Impact:      Similar (parallelization maintained)    │
└───────────────────────────────────────────────────────────┘

ROUTING DECISIONS
┌─────────────┬───────┬────────┬──────────────────────────────┐
│ Error Type  │ Count │ Model  │ Reasoning                    │
├─────────────┼───────┼────────┼──────────────────────────────┤
│ Missing type│  10   │ Haiku  │ Simple addition, no logic    │
│ Import typo │   5   │ Haiku  │ Straightforward fix          │
│ Async error │   3   │ Sonnet │ Requires flow understanding  │
│ Type infer  │   1   │ Sonnet │ Complex type relationships   │
│ Architect   │   1   │ Opus   │ Deep refactoring needed      │
└─────────────┴───────┴────────┴──────────────────────────────┘

COST OVER TIME (Cumulative)
$30 ┤
    │                                              ╱── Standard ($27)
$25 ┤                                        ╱────╱
    │                                  ╱────╱
$20 ┤                            ╱────╱
    │                      ╱────╱
$15 ┤                ╱────╱
    │          ╱────╱
$10 ┤    ╱────╱                    ╱───────────── Ecomode ($6)
    │───╱                    ╱────╱
 $5 ┤                  ╱────╱
    │            ╱────╱
 $0 ┼───────────╱
    └────┴────┴────┴────┴────┴────┴────┴────┴────┴────
    0    2    4    6    8   10   12   14   16   18   20
                        Agents Completed

KEY INSIGHT: Ecomode maintains parallelism while routing each task
to the most cost-effective model that can handle it successfully.
```

---

## Capture Techniques

### Terminal Recording
```bash
# Use asciinema for terminal recording
asciinema rec -t "OMC Autopilot Demo" autopilot-demo.cast

# Convert to animated GIF
agg autopilot-demo.cast autopilot-phases.gif

# Or capture PNG at specific frame
agg autopilot-demo.cast autopilot-phases.png --frame 240
```

### Split Terminal Setup
```bash
# Using tmux
tmux new-session \; \
  split-window -h \; \
  select-pane -t 0 \; \
  send-keys "# BEFORE: Manual workflow" C-m \; \
  select-pane -t 1 \; \
  send-keys "# AFTER: OMC workflow" C-m
```

### Screenshot Tools
```bash
# Linux
gnome-screenshot --area
scrot -s

# macOS
Cmd+Shift+4

# Windows
Snipping Tool
```

### Terminal Styling for Screenshots
```bash
# Recommended terminal settings
- Theme: Dracula or Nord
- Font: Fira Code or JetBrains Mono
- Size: 14pt
- Window size: 100x40
- Transparency: Off (for clarity)
```

---

## Fallback: Using ASCII Mockups

If live screenshots aren't available, the ASCII mockups in this guide are designed to be used directly:

1. Copy the ASCII art to a text file
2. Open in a monospace font viewer
3. Export as PNG with dark background
4. Or screenshot the ASCII art displayed in terminal

**Recommended ASCII → Image Tools:**
- [carbon.now.sh](https://carbon.now.sh) - Beautiful code screenshots
- [terminalizer](https://terminalizer.com) - Terminal to animated GIF
- [asciinema](https://asciinema.org) - Terminal session recorder

---

## Verification Checklist

Before seminar day:

- [ ] All 10 screenshots captured or mockups prepared
- [ ] Screenshots match slide numbers
- [ ] Image format: PNG, 1920x1080 or 2560x1440
- [ ] Readable text (not too small)
- [ ] Dark theme for consistency
- [ ] No sensitive information visible
- [ ] Filenames match reference in this guide
- [ ] Backup ASCII mockups available
- [ ] Tested display on presentation screen

---

## Notes

- Prioritize captures for Slides 6, 10, 30, 35 (marked HIGH priority)
- ASCII mockups can serve as standalone visuals if needed
- Consider creating animated GIFs for autopilot and pipeline flows
- Test readability on projector before seminar
- Have backup static diagrams for agent-tiers and -savings

For questions or issues capturing screenshots, refer to the ASCII mockups as reference or create diagrams using the layout shown.
