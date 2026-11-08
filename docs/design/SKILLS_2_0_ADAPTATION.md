# Skills 2.0 Adaptation for OMC (MVP)

## Context

The broader AI coding-agent ecosystem is converging on a more package-oriented skill model:

- reusable workflows live in directory-based skill packages
- skills ship bundled resources, not just prose
- orchestration surfaces increasingly expose explicit handoffs, tools, and workflow contracts

OMC already has strong foundations here:

- `SKILL.md` frontmatter
- slash-loaded skills
- builtin skill loading
- pipeline / handoff metadata

This MVP focuses on the smallest concrete adaptation that improves interoperability without forcing a large schema migration.

## Research summary

### Anthropic Claude Code

Claude Code's custom subagent model emphasizes:

- specialized workflow packaging
- scoped capabilities and tools
- explicit subagent composition
- preloaded skills/resources

### OpenAI Agents SDK

The Agents SDK treats the following as first-class:

- tools
- handoffs
- workflows/pipelines
- guardrails

### Agent Skills ecosystem

The Agent Skills ecosystem centers on project-local skill packaging conventions such as `.agents/skills/`, with bundled artifacts that should be reused by the agent at execution time.

## OMC gaps

1. **Project-local compatibility gap**
   - OMC's canonical project-local skill directory is `.omc/skills/`
   - emerging conventions also use `.agents/skills/`
   - OMC should interoperate without abandoning its own canonical layout

2. **Bundled-resource visibility gap**
   - OMC renders skill markdown well
   - but it does not consistently call attention to `lib/`, `templates/`, scripts, or helper files shipped beside the skill
   - this increases needless reinvention and reduces package leverage

## MVP scope implemented in Phase 1

### 1. Compatibility read support for `.agents/skills/`

- Keep `.omc/skills/` as the canonical OMC project-local skill directory
- Add `.agents/skills/` as a compatibility read source for:
  - learned/project skill discovery
  - slash-loaded skill discovery
- Preserve deterministic priority order:
  - project commands
  - user commands
  - project `.omc/skills`
  - project `.agents/skills`
  - user skill directories

### 2. Standardized `Skill Resources` rendering

When a skill directory contains extra bundled assets beyond `SKILL.md`, OMC now appends a standardized block:

- skill directory path
- bundled resource entries (for example `lib/`, `templates/`, scripts)
- a reuse-first reminder

This is rendered for:

- builtin skills
- slash-loaded skills

## Why this slice

This MVP is intentionally narrow:

- high practical value
- low migration risk
- no new dependency
- backward compatible with current skill metadata

It gives OMC a real step toward a "skills 2.0" model without prematurely freezing a large frontmatter schema.

## Deferred follow-ups

### Phase 2

Add optional richer skill contract metadata, potentially including:

- deliverables
- artifact paths
- allowed tools
- model/runtime preferences
- explicit execution constraints

### Phase 3

Add validation / diagnostics around richer contracts and potentially artifact-first execution helpers.

## Risks

- `.agents/skills/` compatibility may surface overlapping names if users intentionally mirror the same skill in both locations; precedence is now explicit, but duplication may still confuse humans.
- `Skill Resources` currently summarizes top-level bundled assets only; deeper artifact indexing is out of scope for the MVP.
- This does not yet introduce a richer validated schema; it improves packaging and discoverability first.
