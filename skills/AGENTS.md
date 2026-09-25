<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-09-05 -->

# skills

47 skill directories for workflow automation and specialized behaviors.

## Purpose

Skills are reusable workflow templates that can be invoked via `/oh-my-claudecode:skill-name`. Each skill provides:
- Structured prompts for specific workflows
- Activation triggers (manual or automatic)
- Integration with execution modes

## Key Files

### Execution Mode Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `autopilot/SKILL.md` | autopilot | Full autonomous execution from idea to working code |
| `execute/SKILL.md` | execute | Carry an approved task through to working, verified code |
| `launch/SKILL.md` | launch | Governed delivery pipeline: spec → vertical-slice tickets → frontier execution with human checkpoints |
| `ralph/SKILL.md` | ralph | Persistence until verified complete |
| `review/SKILL.md` | omc-review | Evaluate finished work for defects, risk, and simplification before it ships |
| `team/SKILL.md` | team | N coordinated agents with task claiming |
| `ultragoal/SKILL.md` | ultragoal | Durable multi-goal workflow persisting plan/ledger artifacts under `.omc/ultragoal` |
| `verify/SKILL.md` | verify | Evidence-backed completion verification for finished work |

### Planning Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `plan/SKILL.md` | omc-plan | Strategic planning with interview workflow |
| `ralplan/SKILL.md` | ralplan | Iterative planning (Planner+Architect+Critic) with RALPLAN-DR structured deliberation (`--deliberate` for high-risk) |
| `deep-interview/SKILL.md` | deep-interview | Socratic deep interview with mathematical ambiguity gating (Ouroboros-inspired) |
| `ask-navigator/SKILL.md` | ask-navigator | Shipyard navigator: chart foggy efforts into decision-ticket maps, one ticket per session, then hand a mission brief to launch |
| `intent/SKILL.md` | intent | Shipyard requirements intake for non-engineer contributors — turn a pasted chat log into an accepted intent |

### Exploration Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `deepinit/SKILL.md` | deepinit | Generate hierarchical AGENTS.md |
| `research/SKILL.md` | research | Investigate an open question and return grounded, sourced findings |
| `external-context/SKILL.md` | external-context | Invoke parallel document-specialist agents for external web searches and documentation lookup |
| `autoresearch/SKILL.md` | autoresearch | Stateful single-mission improvement loop with strict evaluator contract and markdown decision logs |
| `trace/SKILL.md` | trace | Evidence-driven tracing lane orchestrating competing tracer hypotheses |

### Visual Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `diagram/SKILL.md` | diagram | Model-invoked visual explanations — smallest view (pseudocode, tree, Mermaid, diff) that carries the point |
| `visual-verdict/SKILL.md` | visual-verdict | Structured visual QA verdict for screenshot/reference comparisons |

### Utility Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `ai-slop-cleaner/SKILL.md` | ai-slop-cleaner | Regression-safe cleanup workflow for AI-generated code slop |
| `agent-doc-discipline/SKILL.md` | agent-doc-discipline | Writing-time discipline for agent-facing documents |
| `drydock/SKILL.md` | drydock | Shipyard harness scaffold: 4-pillar shared environment across 5 surfaces, with --check drift audit |
| `harbor/SKILL.md` | harbor | Shipyard intake gate: sweeps external issues and PRs, verifies claims, hands the maintainer a signature docket |
| `loft/SKILL.md` | loft | Shipyard shape-before-steel discipline: throwaway artifacts answer design questions prose cannot settle |
| `refit/SKILL.md` | refit | Cross-session environment retrospective: OMC instruments (trace, friction, logs, notepads) in, user-approved fixes out onto checks/steering/tooling/information surfaces |
| `minimal-code-discipline/SKILL.md` | minimal-code-discipline | YAGNI-ladder writing-time discipline: existence-first, reuse before writing, shortest correct diff |
| `minimal-prose-discipline/SKILL.md` | minimal-prose-discipline | Writing-time discipline for the agent's own prose: protected core, no filler, close on the action |
| `tdd/SKILL.md` | tdd | Test-first discipline at pre-agreed seams: tracer-bullet red/green, independent expected values, boundary-class-only substitution |
| `map/SKILL.md` | map | The yard's skill map: which skill owns which job, in delivery-loop order; routes, never executes |
| `skillify/SKILL.md` | skillify | Extract reusable skill from session |
| `ask/SKILL.md` | ask | Ask Claude, Codex, or Gemini via `omc ask` and capture an artifact |
| `cancel/SKILL.md` | cancel | Cancel any active OMC mode |
| `hud/SKILL.md` | hud | Configure HUD display |
| `omc-doctor/SKILL.md` | omc-doctor | Diagnose installation issues |
| `omc-setup/SKILL.md` | omc-setup | One-time setup wizard |
| `skill/SKILL.md` | skill | Manage local skills |
| `pr/SKILL.md` | pr | PR body assembly from OMC's paper trail: smallest-visual summary (show-me credit), verify-protocol evidence, ADR-test reversibility |
| `architecture-survey/SKILL.md` | architecture-survey | Periodic architecture survey: ranked deepening candidates (shallow modules, hypothetical seams), survey never refactors |
| `configure-notifications/SKILL.md` | configure-notifications | Configure notification integrations (Telegram, Discord, Slack) via natural language |
| `debug/SKILL.md` | debug | Diagnose the current OMC session or repo state using logs, traces, state, and focused reproduction |
| `graph/SKILL.md` | graph | Deterministic orchestration graph runtime — declarative DAG pipelines with journal-based crash recovery |
| `remember/SKILL.md` | remember | Review reusable project knowledge and decide what belongs in project memory, notepad, or durable docs |
| `self-improve/SKILL.md` | self-improve | Autonomous evolutionary code improvement engine with tournament selection |
| `wiki/SKILL.md` | wiki | LLM Wiki — persistent markdown knowledge base that compounds across sessions |

### Domain Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `project-session-manager/SKILL.md` | project-session-manager (+ `psm` alias) | Isolated dev environments |
| `release/SKILL.md` | release | Generic release assistant — analyzes repo CI/rules, caches in `.omc/RELEASE_RULE.md`, guides the release |
## For AI Agents

### Working In This Directory

#### Skill Template Format

```markdown
---
name: skill-name
description: Brief description
triggers:
  - "keyword1"
  - "keyword2"
agent: executor  # Optional: which agent to use
model: sonnet    # Optional: model override
pipeline: [skill-name, follow-up-skill]  # Optional: standardized multi-skill flow
next-skill: follow-up-skill              # Optional: explicit handoff target
next-skill-args: --direct                # Optional: arguments for the next skill
handoff: .omc/plans/example.md           # Optional: artifact/context handed to next skill
---

# Skill Name

## Purpose
What this skill accomplishes.

## Workflow
1. Step one
2. Step two
3. Step three

## Usage
How to invoke this skill.

## Configuration
Any configurable options.
```

#### Skill Invocation

```bash
# Manual invocation
/oh-my-claudecode:skill-name

# With arguments
/oh-my-claudecode:skill-name arg1 arg2

# Auto-detected from keywords
"autopilot build me a REST API"  # Triggers autopilot skill
```

#### Creating a New Skill

1. Create `new-skill/SKILL.md` directory and file with YAML frontmatter
2. Define purpose, workflow, and usage
3. Add to skill registry (auto-detected from frontmatter)
4. Optionally add activation triggers
5. Create corresponding plugin-scoped skill/slash surface via `skills/new-skill/SKILL.md` (and generated artifacts when the build requires them)
6. Update `docs/REFERENCE.md` (Skills section, count)
7. If execution mode skill, also create `src/hooks/new-skill/` hook

### Common Patterns

**Skill chaining:**
```markdown
## Workflow
1. Invoke `explore` agent for context
2. Invoke `architect` for analysis
3. Invoke `executor` for implementation
4. Invoke `qa-tester` for verification
```

If `pipeline` / `next-skill` metadata is present, OMC appends a standardized **Skill Pipeline** handoff block to the rendered skill prompt so downstream steps are explicit.

**Conditional behavior:**
```markdown
## Workflow
1. Check if tests exist
   - If yes: Run tests first
   - If no: Create test plan
2. Proceed with implementation
```

### Testing Requirements

- Skills are verified via integration tests
- Test skill invocation with `/oh-my-claudecode:skill-name`
- Verify trigger keywords activate correct skill
- For git-related skills, follow `templates/rules/git-workflow.md`

## Dependencies

### Internal
- Loaded by skill bridge (`scripts/build-skill-bridge.mjs`)
- References agents from `agents/`
- Uses hooks from `src/hooks/`

### External
None - pure markdown files.

## Skill Categories

| Category | Skills | Trigger Keywords |
|----------|--------|------------------|
| Execution | autopilot, ralph, team | "autopilot", "ralph", "team" |
| Cleanup | ai-slop-cleaner | "deslop", "anti-slop", cleanup/refactor + slop smells |
| Planning | omc-plan, ralplan, deep-interview | "plan this", "interview me", "ouroboros" |
| Exploration | deepinit, external-context, research | "deepinit", "research" |
| Utility | skillify, cancel, hud, omc-doctor, omc-setup | "stop", "cancel" |
| Domain | psm, release | psm context |

## Auto-Activation

Some skills activate automatically based on context:

| Skill | Auto-Trigger Condition |
|-------|----------------------|
| autopilot | "autopilot", "build me", "I want a" |
| ralph | "ralph", "don't stop until" |
| deep-interview | "deep interview", "interview me", "ouroboros", "don't assume" |
| cancel | "stop", "cancel", "abort" |

<!-- MANUAL:
- Team runtime wait semantics: `omc_run_team_wait.timeout_ms` only limits the wait call and does not stop workers.
- `timeoutSeconds` is removed from `omc_run_team_start`; use explicit `omc_run_team_cleanup` for intentional worker pane termination.
-->
