---
name: skillify
description: Turn a repeatable workflow from the current session into a reusable OMC skill draft
---

# Skillify

Use this skill when the current session uncovered a repeatable workflow that should become a reusable OMC skill.

## Goal
Capture a successful multi-step workflow as a concrete skill draft instead of rediscovering it later.

## Workflow
1. Identify the repeatable task the session accomplished.
2. Extract:
   - inputs
   - ordered steps
   - success criteria
   - constraints / pitfalls
   - best target location for the skill
3. Decide whether the workflow belongs as:
   - a repo built-in skill
   - a user/project learned skill
   - documentation only
4. Draft the SKILL.md content with clear triggers, steps, and success criteria.
5. Point out anything still too fuzzy to encode safely.

## Rules
- Only capture workflows that are actually repeatable.
- Keep the skill practical and scoped.
- Prefer explicit success criteria over vague prose.
- If the workflow still has unresolved branching decisions, note them before drafting.

## Output
- Proposed skill name
- Target location
- Draft workflow structure
- Open questions, if any
