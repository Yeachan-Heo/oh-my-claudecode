---
name: create-verification-skill
description: Generate the project's own verification skill at .claude/skills/verify/ — how to build, test, lint, typecheck, and manually check THIS repo, discovered by running the real commands and recording what actually works, plus a feature map of what each check covers. Use once per repo so every later "verify" has project-specific teeth instead of generic guesses.
aliases: []
metadata:
  credits:
    verification-skill-generator: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Create Verification Skill

The bundled `verify` skill demands evidence but cannot know this repo's
commands. This skill generates the project-local `verify` skill that makes
verification concrete — by discovering the commands through execution, not
by guessing from a README.

## When to use

- a repo has no `.claude/skills/verify/` and work will be verified here
  more than once
- the generic verification flow keeps guessing commands wrong for this repo

## Workflow

1. **Discover by running.** For each candidate surface — build, test, lint,
   typecheck, format, dev server, e2e — find the command (package scripts,
   Makefile, CI config) and **run it**. Record the real invocation, the
   expected passing output shape, the runtime, and the known gotchas
   (env vars, seed data, order dependence). A command you have not run is a
   hypothesis, not a check.
2. **Record the manual surface.** What cannot be checked by command here:
   the pages or flows a human (or `run`/`visual-verdict`) exercises, and
   what "looks right" means for each.
3. **Write the feature map.** A table of what each check actually covers —
   which entry points, which layers, what it cannot see. The map is the
   skill's honesty: verification strength is knowable, not assumed.
4. **Generate** `.claude/skills/verify/SKILL.md` containing: the exact
   commands with expected outcomes, the manual checks, the feature map, and
   the escalation path (which failure means what, who owns it). Keep it
   short enough that a fresh session reads it whole.
5. **Prove it.** Run the generated skill's own flow once end to end on a
   real change and record the result in
   `.omc/state/verification-ledger.tsv` (verdict `unit-test-verified`,
   evidence = the commands run).

## Rules

- Every command in the generated skill was executed this session, or is
  marked unverified with the reason.
- The generated skill verifies; it never fixes. Fixes route to `execute`.
- When the repo's commands change shape, `maintain-verification-skill`
  re-syncs this artifact.
