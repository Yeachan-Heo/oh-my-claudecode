# Demo 1: Autopilot - Full Autonomous Execution

**Duration:** 5 minutes
**Objective:** Demonstrate end-to-end autonomous development from high-level idea to working, tested code

## Pre-requisites

- Clean demo directory
- OMC installed and configured
- Node.js and npm available
- Terminal visible to audience

## Setup (30 seconds before demo)

```bash
# Create clean workspace
mkdir -p ~/demo-workspace/bookstore-api
cd ~/demo-workspace/bookstore-api

# Verify clean state
ls -la  # Should be empty

# Clear any previous OMC state
rm -rf .omc
```

## The Command

```
autopilot: build a REST API for a bookstore inventory with CRUD operations for books
```

## Expected Flow (4-5 minutes)

### Phase 1: Expansion (0:00-0:30)
**What happens:**
- OMC announces: "I'm activating autopilot for full autonomous execution..."
- Analyst agent spawned to create detailed specification
- Requirements expanded: models, routes, validation, tests

**Presenter talking points while running:**
- "Autopilot starts by expanding your high-level idea into a detailed spec"
- "Notice the analyst agent is creating requirements automatically"
- "It's thinking about data models, API routes, validation rules, testing strategy"

### Phase 2: Planning (0:30-1:30)
**What happens:**
- Architect agent designs system architecture
- Critic agent validates the design
- File structure created: `src/`, `tests/`, `package.json`

**Presenter talking points:**
- "Now the architect is designing the system structure"
- "The critic reviews the architecture to catch issues early"
- "This is multi-agent consensus - no single agent makes all decisions"
- Point to HUD: "See the active agents in the statusline"

### Phase 3: Execution (1:30-3:30)
**What happens:**
- Multiple executor agents spawned in parallel
- Files created: `src/models/Book.ts`, `src/routes/books.ts`, `src/app.ts`
- Dependencies installed: express, typescript, validation libs
- Tests written: `tests/books.test.ts`

**Presenter talking points:**
- "Now multiple executor agents work in parallel"
- "One handles models, another routes, another tests"
- "All happening simultaneously - this is ultrawork embedded in autopilot"
- "Dependencies are installing in the background"

### Phase 4: QA Cycles (3:30-4:30)
**What happens:**
- Build-fixer runs TypeScript compilation
- QA-tester runs test suite
- Errors found and auto-corrected
- Re-run until all pass

**Presenter talking points:**
- "QA cycle: build, test, fix errors, repeat"
- "If tests fail, agents debug and fix automatically"
- "This is the persistence - it won't stop until everything works"

### Phase 5: Validation (4:30-5:00)
**What happens:**
- Architect verifies implementation matches spec
- Security-reviewer checks for vulnerabilities
- Code-reviewer validates code quality
- Final approval and summary

**Presenter talking points:**
- "Final validation by architect, security, and code review agents"
- "Only completes when all verifications pass"
- "This is what 'done' means in autopilot - truly production-ready"

## Expected Output

### File Structure
```
bookstore-api/
├── package.json
├── tsconfig.json
├── src/
│   ├── models/
│   │   └── Book.ts
│   ├── routes/
│   │   └── books.ts
│   ├── middleware/
│   │   └── validation.ts
│   └── app.ts
├── tests/
│   └── books.test.ts
└── .omc/
    ├── plans/autopilot-bookstore-api.md
    └── notepads/autopilot-bookstore-api/
        └── learnings.md
```

### Working API
```bash
# Start the server
npm start

# Test endpoints
curl http://localhost:3000/books
curl -X POST http://localhost:3000/books -d '{"title":"1984","author":"Orwell","isbn":"123","quantity":5}'
curl -X GET http://localhost:3000/books/123
curl -X PUT http://localhost:3000/books/123 -d '{"quantity":10}'
curl -X DELETE http://localhost:3000/books/123

# Run tests
npm test  # All passing
```

## Key Talking Points

### What makes autopilot special?
1. **Zero manual steps** - From idea to working code with one command
2. **Multi-phase workflow** - Expansion → Planning → Execution → QA → Validation
3. **Embedded parallelism** - Multiple agents work simultaneously
4. **Self-correction** - Automatically fixes errors until tests pass
5. **Production-ready** - Not just "works on my machine" - fully validated

### Why this matters
- "Traditional AI coding: You write prompts, fix errors, iterate manually"
- "Autopilot: You state intent, AI handles everything including error correction"
- "It's like having a senior developer who doesn't stop until the feature is complete"

### Architecture highlight
- "Notice we didn't specify 'use TypeScript' or 'write tests' - autopilot chose best practices automatically"
- "The analyst expanded our vague request into a proper specification"
- "Multiple agents collaborated - no single agent did everything"

## Fallback: Pre-recorded Output

If live demo fails, show this realistic terminal output:

```
$ autopilot: build a REST API for a bookstore inventory with CRUD operations for books

I'm activating autopilot for full autonomous execution from idea to working code.

[EXPANSION PHASE]
Spawning analyst to create detailed specification...
✓ Analyst completed requirements analysis (12s)
  - Data model: Book (title, author, isbn, quantity, price)
  - Routes: GET /books, POST /books, GET /books/:id, PUT /books/:id, DELETE /books/:id
  - Validation: ISBN format, required fields, quantity >= 0
  - Testing: Unit tests for routes, integration tests for CRUD flow

[PLANNING PHASE]
Spawning architect to design system...
✓ Architect created architecture plan (18s)
  - Stack: Node.js + Express + TypeScript
  - Structure: MVC pattern with routes, models, middleware
  - Storage: In-memory for demo (easily swappable)

Spawning critic to validate design...
✓ Critic approved architecture (8s)
  - No blocking issues found
  - Suggested: Add input validation middleware

[EXECUTION PHASE - PARALLEL]
Spawning 3 executor agents...

[executor-1] Creating data models...
[executor-2] Implementing routes...
[executor-3] Writing tests...
[background] Installing dependencies: express, typescript, jest, ts-node...

✓ executor-1 completed Book model (22s)
✓ executor-2 completed CRUD routes (28s)
✓ executor-3 completed test suite (25s)
✓ Dependencies installed (31s)

[QA PHASE]
Running build-fixer for TypeScript compilation...
✓ Build passed (4s)

Running qa-tester for test execution...
✗ Test failed: Missing validation middleware (3s)

Auto-correction: Spawning executor to add validation...
✓ Validation middleware added (12s)

Re-running tests...
✓ All tests passed (3s) - 12/12 passing

[VALIDATION PHASE]
Spawning architect for final verification...
✓ Architect verified: Implementation matches specification (15s)

Spawning security-reviewer...
✓ Security review passed: No vulnerabilities detected (8s)

Spawning code-reviewer...
✓ Code review passed: Follows best practices (6s)

[COMPLETE]
Bookstore API successfully created!

Summary:
  - 8 files created
  - 12 tests passing
  - 0 TypeScript errors
  - 0 security issues
  - Ready for deployment

Total time: 3m 42s
Active agents used: 8 (analyst, architect, critic, 3x executor, qa-tester, security-reviewer, code-reviewer)

Next steps:
  - Run: npm start
  - Test: curl http://localhost:3000/books
  - Deploy: Add production database and deploy
```

## Common Issues & Troubleshooting

### Issue: Autopilot takes longer than 5 minutes
**Solution:**
- Let Phase 1-2 complete, then skip to Phase 5 and show fallback output for middle phases
- Explain: "In production this might take 5-10 minutes for complex features"

### Issue: Network error during npm install
**Solution:**
- Acknowledge the error: "Network hiccup - happens in live demos"
- Show fallback output: "Here's what would have completed..."
- Explain the remaining phases verbally

### Issue: Test failures during QA phase
**Solution:**
- Actually good for the demo! Point it out: "See? It found an issue and is fixing it automatically"
- Wait for auto-correction to complete
- Emphasize: "This is the self-correction in action"

## Transition to Next Demo

"That's autopilot - fully autonomous from idea to production-ready code. But what if you just need speed? What if you have a working codebase with multiple issues and want them all fixed simultaneously? That's where ultrawork comes in - our next demo."

**Transition action:** Open terminal with prepared project containing TypeScript errors for Demo 2

## Q&A Preparation

**Q: How does it choose which agents to spawn?**
A: The autopilot orchestrator analyzes the task and selects appropriate specialists. For a REST API, it knows to use analysts for specs, architects for design, executors for implementation, and QA agents for testing.

**Q: What if I don't like the choices it made?**
A: You can guide it with constraints: "autopilot: build a REST API using Go and PostgreSQL" or use planning mode first to review before execution.

**Q: How much does this cost in tokens?**
A: For this demo, roughly 150K-300K tokens (~$1-2 with Sonnet). But you get production-ready code with tests, not just a first draft.

**Q: Can it handle larger projects?**
A: Yes! Autopilot scales. We've built entire microservices, fullstack apps, and refactored legacy codebases. For very large projects, consider ultrapilot (next level up).

**Q: What happens if it gets stuck?**
A: Ralph mode (Demo 5) adds even more persistence. But autopilot already has retry logic and architect verification to prevent getting stuck.
