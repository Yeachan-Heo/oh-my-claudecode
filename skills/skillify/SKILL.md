---
name: skillify
aliases: [learner]
description: Turn a repeatable workflow from the current session into a reusable OMC skill draft
---

# Skillify

Use this skill when the current session uncovered a repeatable workflow that should become a reusable OMC skill.

> Compatibility: `/oh-my-claudecode:learner` is a deprecated alias for this skill. Prefer `/oh-my-claudecode:skillify` in docs, prompts, and new workflows. Internal implementation modules may still use the learner name.

## Goal
Capture a successful multi-step workflow as a concrete skill draft instead of rediscovering it later.

## Quality Gate
Before extracting a skill, all three should be true:
- "Could someone Google this in 5 minutes?" → No.
- "Is this specific to this codebase, project, or workflow?" → Yes.
- "Did this take real debugging, design, or operational effort to discover?" → Yes.

Prefer skills that encode decision-making heuristics, constraints, pitfalls, and verification steps. Avoid generic snippets, boilerplate, or library usage examples that belong in normal documentation.

## Workflow
1. Identify the repeatable task the session accomplished.
2. Extract:
   - inputs
   - ordered steps
   - success criteria
   - constraints / pitfalls
   - verification evidence
   - best target location for the skill
3. Decide whether the workflow belongs as:
   - a repo built-in skill
   - a user/project learned skill
   - documentation only
4. When drafting a learned skill file, output a complete skill file that starts with YAML frontmatter.
   - Never emit plain markdown-only skill files.
   - Do **not** write plain markdown without frontmatter.
   - Minimum frontmatter:
     ```yaml
     ---
     name: <skill-name>
     description: <one-line description>
     triggers:
       - <trigger-1>
       - <trigger-2>
     ---
     ```
   - Write learned/user/project skills to flat file-backed paths:
     - `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/omc-learned/<skill-name>.md`
     - `.omc/skills/<skill-name>.md`
   - Remember that uncommitted skills are still worktree-local until committed or copied to a user-level directory.
5. Draft the rest of the skill file with clear triggers, steps, success criteria, and pitfalls.
6. Point out anything still too fuzzy to encode safely.

## Rules
- Only capture workflows that are actually repeatable.
- Keep the skill practical and scoped.
- Prefer explicit success criteria over vague prose.
- If the workflow still has unresolved branching decisions, note them before drafting.
- Keep `omc-learned` as the storage directory name for compatibility; do not present it as the public invocation name.

## Output
- Proposed skill name
- Target location
- Draft workflow structure or complete skill file
- Verification or quality-gate notes
- Open questions, if any
