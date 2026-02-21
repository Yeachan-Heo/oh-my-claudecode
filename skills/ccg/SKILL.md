---
name: ccg
description: Claude-Codex-Gemini tri-model orchestration - fans out backend tasks to Codex and frontend/UI tasks to Gemini in parallel, then Claude synthesizes results
---

# CCG (Claude-Codex-Gemini) Orchestration

## Overview

CCG is a tri-model orchestration pattern:

- **Claude** — Orchestrator/conductor: decomposes requests, fans out work, synthesizes results
- **Codex** (OpenAI) — Backend/code engine: architecture, APIs, security, code analysis
- **Gemini** (Google) — Frontend/design processor: UI components, styling, visual design, large-context tasks

Claude fans Codex and Gemini out **in parallel**, then synthesizes their outputs into a unified solution.

## Trigger

Activated when the user says `ccg` or `claude-codex-gemini` in their prompt.

## Execution Protocol

**ANNOUNCE immediately**: `"CCG MODE ENABLED — Orchestrating Claude + Codex + Gemini"`

### Phase 1: Decompose

Analyze the request and split into:
- **Backend tasks** → Codex (APIs, data models, business logic, tests, security)
- **Frontend tasks** → Gemini (UI components, styling, layout, responsive design)
- **Synthesis tasks** → Claude (integration, cross-cutting concerns, final wiring)

### Phase 2: Fan-Out (Parallel)

Run Codex and Gemini **simultaneously** using background mode.

**Codex — backend**:
1. Write prompt to `.omc/prompts/codex-{purpose}-{timestamp}.md`
2. Call `ask_codex` MCP tool:
   - `agent_role`: pick from `architect`, `executor`, `code-reviewer`, `security-reviewer`, `planner`, `critic`
   - `prompt_file`: the file you just wrote
   - `output_file`: `.omc/prompts/codex-{purpose}-{timestamp}-output.md`
   - `context_files`: relevant source files
   - `background: true` for non-blocking execution

**Gemini — frontend**:
1. Write prompt to `.omc/prompts/gemini-{purpose}-{timestamp}.md`
2. Call `ask_gemini` MCP tool:
   - `agent_role`: pick from `designer`, `writer`, `vision`
   - `prompt_file`: the file you just wrote
   - `output_file`: `.omc/prompts/gemini-{purpose}-{timestamp}-output.md`
   - `files`: relevant source files
   - `background: true` for non-blocking execution

### Phase 3: Await Results

Use `wait_for_job` (or poll with `check_job_status`) for both jobs. Wait for both to complete before synthesizing.

### Phase 4: Synthesize

Claude reads both output files and:
1. Reconciles any conflicts (e.g., API shape vs component props)
2. Integrates backend + frontend solutions into a cohesive whole
3. Applies cross-cutting concerns (error handling, typing, auth)
4. Implements any remaining integration glue code

## MCP Tool Selection Guide

### Use Codex (`ask_codex`) for:
- REST/GraphQL API design and implementation
- Database schema, migrations, data models
- Backend business logic and services
- Security audit and vulnerability analysis
- Architecture review and refactoring
- Test strategy, TDD, unit/integration tests
- Build errors and TypeScript issues

**Roles**: `architect`, `code-reviewer`, `security-reviewer`, `executor`, `planner`, `critic`, `test-engineer`

### Use Gemini (`ask_gemini`) for:
- React/Vue/Svelte component implementation
- CSS, Tailwind, styled-components
- Responsive layouts and visual design
- UI/UX review and heuristic audits
- Large-scale documentation (1M token context)
- Image/screenshot/diagram analysis

**Roles**: `designer`, `writer`, `vision`

## Fallback

If **Codex MCP unavailable** → use `Task(subagent_type="oh-my-claudecode:executor", model="sonnet")` for backend tasks.

If **Gemini MCP unavailable** → use `Task(subagent_type="oh-my-claudecode:designer", model="sonnet")` for frontend tasks.

If **both unavailable** → use Claude directly with the standard agent catalog.

## Example

**User**: `ccg Add a user profile page with a REST API endpoint and React frontend`

```
CCG MODE ENABLED — Orchestrating Claude + Codex + Gemini

Decomposition:
  Backend  → Codex: /api/users/:id endpoint, Prisma user model, auth middleware
  Frontend → Gemini: React UserProfile component, avatar, form, responsive layout

Fan-out (parallel):
  [Codex]  Implementing REST endpoint + data layer...
  [Gemini] Designing UserProfile component + styling...

[Both complete]

Synthesis:
  - Align API response type with React component props
  - Wire fetch hook to /api/users/:id endpoint
  - Add error boundary and loading state across layers
  - Export unified UserProfilePage with data fetching
```

## Integration with Other Skills

CCG composes with other OMC modes:

| Combination | Effect |
|-------------|--------|
| `ccg ralph` | CCG loop with ralph persistence until verified complete |
| `ccg ultrawork` | CCG with max parallelism within each model |
| `ccg team` | CCG orchestration within a multi-agent team |

## Cancellation

Stop active CCG work: say `cancelomc` or run `/oh-my-claudecode:cancel`.

## State

CCG does not maintain persistent state files. Each invocation is stateless — Claude manages the workflow inline. MCP job IDs are tracked in-context during the session.
