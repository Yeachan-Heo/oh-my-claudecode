---
name: prompt-library
description: Curated prompt templates for common developer tasks with contextual suggestions and effectiveness tracking
level: 2
aliases: [prompts, templates, prompt-templates]
argument-hint: [list|search <query>|use <name>|add] - default is list
---

# Prompt Library Skill

A curated collection of battle-tested prompt templates for common Claude Code tasks. Browse, search, and use templates that produce consistently high-quality results.

## Usage

```
/oh-my-claudecode:prompt-library
/oh-my-claudecode:prompt-library list
/oh-my-claudecode:prompt-library search debugging
/oh-my-claudecode:prompt-library use bug-fix
/oh-my-claudecode:prompts
```

Or say: "show me prompt templates", "best prompt for debugging", "how to prompt for code review"

## Workflow

### Mode: List (default)

Display the template catalog organized by category:

```
[PROMPT LIBRARY] Template Catalog
═══════════════════════════════════════════

🔍 DEBUGGING & INVESTIGATION
  bug-fix          Fix a specific bug with root cause analysis
  error-trace      Trace an error from symptom to root cause
  regression       Find what change caused a regression
  perf-issue       Diagnose performance problem

🏗️ ARCHITECTURE & PLANNING
  new-feature      Plan and implement a new feature
  refactor         Refactor code safely with tests
  api-design       Design a REST/GraphQL API endpoint
  data-model       Design database schema or data model

💻 CODING & IMPLEMENTATION
  implement        Implement from a spec or requirements
  test-first       Write tests first, then implementation (TDD)
  code-review      Review code for quality and issues
  migration        Migrate between frameworks or patterns

📋 PROJECT MANAGEMENT
  pr-description   Write a clear PR description
  commit-msg       Draft a conventional commit message
  changelog        Generate changelog from commits
  docs-update      Update documentation after changes

🔧 DEVOPS & INFRASTRUCTURE
  ci-workflow       Create CI/CD pipeline
  docker-setup      Containerize an application
  deploy-check      Pre-deployment verification checklist
  env-setup         Set up development environment

Use: /oh-my-claudecode:prompt-library use <name>
```

### Mode: Search

Search templates by keyword:

```
/oh-my-claudecode:prompt-library search debugging
```

Returns matching templates with relevance ranking.

### Mode: Use

Load a specific template with contextual guidance:

#### Template: bug-fix
```
I need to fix a bug:

**Symptom**: [What's happening — be specific with error messages, screenshots, or unexpected behavior]
**Expected**: [What should happen instead]
**Reproduction**: [Steps to reproduce, or "intermittent"]
**Location**: [File/function if known, or "unknown"]

Please:
1. Reproduce the issue and confirm the symptom
2. Trace to the root cause (don't just treat symptoms)
3. Explain why the bug exists (what assumption was wrong?)
4. Implement the minimal fix
5. Add a test that catches this specific regression
6. Verify the fix doesn't break related functionality
```

#### Template: new-feature
```
I need to add a new feature:

**Feature**: [What it does — user-facing description]
**Context**: [Why it's needed, who uses it]
**Constraints**: [Technical constraints, compatibility needs, performance requirements]
**Existing patterns**: [Similar features in the codebase to follow]

Please:
1. Explore the codebase to understand existing patterns
2. Propose an implementation plan (don't code yet)
3. Wait for my approval on the plan
4. Implement with tests
5. Verify it works end-to-end
```

#### Template: refactor
```
I need to refactor:

**Target**: [File(s) or module to refactor]
**Goal**: [What improvement — readability, performance, maintainability, type safety]
**Constraint**: [Behavior must not change / specific behavior can change]

Please:
1. Read and understand the current implementation
2. Ensure existing tests pass (run them first)
3. Make changes incrementally — one logical change per step
4. Run tests after each step
5. Show me the diff summary when done
```

#### Template: code-review
```
Review this code for:

**Files**: [List of files or "recent changes"]
**Focus areas**: [Security, performance, correctness, style — or "all"]
**Context**: [What the code does, any known concerns]

Please check:
1. Correctness — does it do what it claims?
2. Edge cases — what inputs/states are unhandled?
3. Security — any injection, auth, or data exposure risks?
4. Performance — any O(n²), unnecessary allocations, missing indexes?
5. Maintainability — naming, structure, documentation
6. Tests — adequate coverage for the changes?

Rate each finding: CRITICAL / HIGH / MEDIUM / LOW
```

#### Template: error-trace
```
I'm seeing this error:

**Error**: [Full error message or stack trace]
**When**: [What action triggers it]
**Since**: [When it started, or "always"]
**Tried**: [What I've already tried]

Please:
1. Parse the error message and stack trace
2. Identify the immediate cause
3. Trace backwards to the root cause
4. Explain the chain of causation
5. Provide the fix with explanation
```

#### Template: test-first
```
I want to implement using TDD:

**Feature**: [What to implement]
**Interface**: [Expected function signature, API shape, or behavior contract]
**Edge cases**: [Known edge cases to cover]

Please:
1. Write the test file first with failing tests
2. Run the tests to confirm they fail
3. Implement the minimum code to pass
4. Refactor while keeping tests green
5. Add edge case tests
6. Final run to confirm all pass
```

#### Template: api-design
```
I need to design an API endpoint:

**Resource**: [What entity/data it manages]
**Operations**: [CRUD? Custom actions?]
**Consumers**: [Who calls this — frontend, mobile, third party]
**Auth**: [Authentication and authorization requirements]

Please:
1. Propose the endpoint design (method, path, request/response shapes)
2. Define error responses and status codes
3. Consider pagination, filtering, sorting if applicable
4. Note rate limiting and caching strategy
5. Generate the implementation after approval
```

#### Template: pr-description
```
Generate a PR description for my current changes:

Please:
1. Run `git diff main...HEAD` to see all changes
2. Summarize the purpose (why, not what)
3. List key changes as bullet points
4. Note any breaking changes or migration steps
5. Suggest testing instructions
6. Format as a GitHub PR description with ## sections
```

#### Template: migration
```
I need to migrate:

**From**: [Current framework/pattern/library]
**To**: [Target framework/pattern/library]
**Scope**: [Entire project, or specific files/modules]
**Constraints**: [Must maintain backwards compatibility? Timeline?]

Please:
1. Analyze current usage of the source pattern
2. Map source patterns to target equivalents
3. Propose a migration plan (incremental, not big-bang)
4. Implement step by step, testing after each step
5. Verify no regressions
```

### Mode: Add

Allow the user to contribute a new template:

1. Ask for: name, category, template text, usage tips
2. Validate format matches the library conventions
3. Suggest writing it to a project-local prompt library at `.claude/prompts/{name}.md`

## Prompt Effectiveness Tips

Display alongside any template:

```
[TIPS] For better results with any prompt:
  1. Be specific — include file paths, function names, error messages
  2. Set constraints — "don't change the API", "keep backwards compatible"
  3. Show context — "this is a React 18 app using Next.js App Router"
  4. State the goal — "optimize for readability" vs "optimize for performance"
  5. One task at a time — break complex work into sequential prompts
  6. Verify don't trust — always ask Claude to run tests and show evidence
```

## Notes

- **Templates are starting points**: Customize them with your specific context for best results.
- **Project-local extensions**: Add custom templates to `.claude/prompts/` for team-specific patterns.
- **Complements OMC skills**: Many templates map to OMC skills (bug-fix → `/trace`, new-feature → `/plan`, code-review → code-reviewer agent).
- **Model-agnostic**: Templates work with any model, but Opus handles the most complex templates best.

---

Begin prompt library now. Parse the mode argument and display the catalog or requested template.
