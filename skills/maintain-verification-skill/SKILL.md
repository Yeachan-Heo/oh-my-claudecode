---
name: maintain-verification-skill
description: "Re-sync the project's verification skill when its commands drift — re-run each recorded command, update expectations and the feature map to what is true now, record the verdict actually earned."
aliases: []
metadata:
  credits:
    verification-skill-maintenance: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Maintain Verification Skill

A verification skill that names dead commands is worse than none: it fails
loudly on trivia and passes quietly on what matters. This skill re-syncs the
project's `verify` skill to the repo's current reality.

## When to use

- verification errors on a command that no longer exists or was renamed
- a new surface (package, app, e2e suite) has no check recorded
- after a toolchain or CI migration

## Workflow

1. **Audit the recorded skill**: list every command and manual check it
   names; for each, does the command still exist and still mean the same
   thing (flags, scripts, config)?
2. **Re-run, don't re-read**: execute each surviving command and compare
   the observed outcome to the recorded expectation. A command whose
   passing shape changed gets its expectation rewritten, with the new
   evidence.
3. **Find uncovered surface**: what does the repo build/check now that the
   feature map does not mention? Add the check by running it, or record the
   gap as uncovered — the map stays honest.
4. **Update the skill and feature map in place**: same file, corrected
   commands, corrected coverage table, dated revision line at the top.
5. **Record** the resync in `.omc/state/verification-ledger.tsv` with the
   verdict the rerun actually earned — `unit-test-verified` when the test
   suite ran, `live-ui-verified` for a live-UI flow, `type-check-only`
   when only build/lint/typecheck commands were rerun — and those commands
   as evidence. Never claim a test ran that did not.

## Rules

- The rerun is the resync; nothing is marked current without execution.
- Coverage that shrank is reported out loud, not silently dropped from the
  map.
- If the project's verification has outgrown the single skill shape (multi-
  package, per-app checks), say so and split per surface rather than
  fattening one file.
