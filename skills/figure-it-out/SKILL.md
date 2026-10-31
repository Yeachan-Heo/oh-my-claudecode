---
name: figure-it-out
description: "Design a rigorous bespoke playbook for a task no bundled skill fits — steps that each end in a check, verification commands, failure branches — stored under .omc/playbooks/ and anchor-validated. For recurring unusual task shapes."
aliases: []
metadata:
  credits:
    bespoke-playbook: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Figure It Out

No bundled skill fits every task. This skill designs the playbook that does
fit — once, rigorously — and leaves it behind as a validated, rerunnable
artifact.

## When to use

- a task shape recurs and no bundled skill covers it (release cut from an
  unusual monorepo, a compliance sweep, a data backfill dance)
- a one-off that is high-stakes enough to deserve a designed procedure
  rather than improvisation

## When not to use

- a bundled skill already fits — check `map` first
- work one agent finishes inside one session — just do it via `execute`

## Design workflow

1. **Objective**: one sentence, executable by a stranger with no chat
   access. Name the deliverable and the done-check.
2. **Steps**: decompose until each step ends in a check a command can
   verify. A step whose exit cannot be checked is two steps, or a guess.
3. **Verification**: for each step, the exact command and the expected
   observable. For the whole playbook, the final evidence that says done.
4. **Failure handling**: for each step, what to do when its check fails —
   retry, rollback, or stop-and-report. Improvisation under failure is where
   playbooks die; write the branch.
5. **Dry-run** the playbook once end to end on the real task, fixing the
   playbook where reality disagreed, not the other way around.

## Storage and validation

Store the result at `.omc/playbooks/<name>.md` with frontmatter:

```markdown
---
extends: <bundled-skill-name>
when: <one sentence naming the requests this playbook serves>
---
```

Anchor every modification of a bundled step with `**After** "<quoted step
text>"` / `**Before**` / `**Replace**` / `**In**`, quoting the bundled skill
verbatim. Then run the checker from its installed location — from a target
project the script does not exist at `./scripts/`, and ordinary launches may
leave both plugin-root variables unset, so resolve before invoking:

```bash
checker="${CLAUDE_PLUGIN_ROOT:-${OMC_PLUGIN_ROOT:-}}/scripts/check-omc-playbooks.mjs"
if [ ! -f "$checker" ] && omc_bin="$(command -v omc 2>/dev/null)"; then
  bin_dir="$(dirname "$(readlink -f "$omc_bin" 2>/dev/null || echo "$omc_bin")")"
  for d in "$bin_dir" "$bin_dir/.." "$bin_dir/../.." "$bin_dir/../../.."; do
    if [ -f "$d/scripts/check-omc-playbooks.mjs" ]; then checker="$d/scripts/check-omc-playbooks.mjs"; break; fi
  done
fi
node "$checker" .
```

Standalone installs reach the script by walking up from the `omc` binary to
the package root that ships `scripts/`. If the checker still cannot be
found, report the resolution failure instead of skipping validation.

It fails when an OMC upgrade rewrites a step you anchored to. Report what it
prints; never guess where an unanchored change belongs.

## Rules

- A step without a check does not ship.
- The playbook states its own scope ceiling: what tasks it must NOT be used
  for.
- Dry-run evidence is recorded in `.omc/state/verification-ledger.tsv`
  before the playbook is declared done.
