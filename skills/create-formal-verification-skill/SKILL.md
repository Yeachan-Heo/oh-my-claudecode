---
name: create-formal-verification-skill
description: Pick the single riskiest invariant in the project, verify it with the tool that fits (TLA+ for concurrency protocols, Lean for exact arithmetic and algorithm properties, Kani for Rust invariant checking), and generate a project-local skill the next agent reruns. Use when tests cannot reach the property — race windows, lock protocols, off-by-one arithmetic in polling loops.
aliases: []
metadata:
  credits:
    formal-verification-method: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Create Formal Verification Skill

Generate a project-local skill that formally verifies one high-risk property
and can be rerun by any later agent. Formal methods pay off only on
properties tests cannot reach; this skill exists to find that one property,
verify it, and leave the verification behind as structure.

## When to use

- a concurrency or locking protocol where interleavings defeat tests
- exact arithmetic a test can sample but not exhaust (backoff schedules,
  quorum math, budget accounting)
- a Rust invariant you want checked over all executions of a function

## When not to use

- ordinary business logic — `verify` and the test suite are the right tools
- more than one property at a time; pick the riskiest, ship it, come back

## Workflow

1. **Survey candidates.** Ask the user (or infer from recent incidents) for
   the invariants whose violation would hurt most. Rank by risk times
   likelihood-of-undetected-breakage. Name the top three and pick one with
   the user when reachable; otherwise pick the riskiest and say so.
2. **Choose the tool by shape, not fashion:**
   - **TLA+** — concurrent processes, locks, retries, distributed-ish
     protocols. Model each atomic step; check safety (nothing bad) and
     liveness (something good eventually) with TLC.
   - **Lean** — exact arithmetic and algorithmic properties. Transcribe the
     computation as a function over naturals; prove the theorem.
   - **Kani** — Rust; harnesses check panics, overflows, and invariants over
     all inputs a function can receive.
   If none fits, say so and stop rather than forcing one.
3. **Model honestly.** Write the spec next to the code it models, citing file
   and line. List every assumption the model makes that the code does not
   guarantee (pid reuse, atomic filesystem steps, integer widths). The
   assumption list is part of the deliverable — an unlisted assumption is an
   unearned theorem.
4. **Verify.** Run the tool (`apalache`/`TLC`, `lake build`, `cargo kani`).
   A violated property is a finding: minimize the counterexample, check
   whether the code shares the flaw, and report before adjusting the model.
5. **Generate the project skill** at
   `.claude/skills/verify-formal-<property>/SKILL.md` containing: the
   property in one sentence, the spec file path, the exact run command, the
   pass criteria, the assumption list, and the source lines the model
   tracks. The next agent reruns the command; it never re-derives the model.
6. **Record** the verification in `.omc/state/verification-ledger.tsv` —
   `formally-verified` only after a green rerun with the run command as
   evidence; a counterexample records `verifier-failed` with the
   counterexample as evidence, and no positive row is written until the
   finding is resolved.

## Maintenance

When the modeled code changes shape (lines move, protocol steps change),
hand to the `maintain-formal-verification-skill` skill: it re-checks each
assumption against current code, updates cited lines, and reruns. A spec
that cites lines that no longer exist is stale, and a stale spec's green is
worthless — say so out loud in the session.

## Rules

- One property per generated skill.
- The model's assumptions are written down, or the verification does not ship.
- A counterexample is reported, never papered over by weakening the property
  to make it pass.
