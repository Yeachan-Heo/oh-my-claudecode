---
name: fix-merge-conflicts
description: Resolve merge conflicts non-interactively — read both sides' intent from their commits, resolve preserving both intents where compatible, run the checks, and finalize without force-push to shared branches. Use when a branch conflicts with its base and you own the branch.
aliases: []
metadata:
  credits:
    conflict-resolution: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Fix Merge Conflicts

A conflict is two intents meeting in one file. Resolution that flattens
either intent is a bug with a clean git status.

## Workflow

1. **Establish ownership**: you resolve conflicts on a branch you own, against
   a base others own. Conflicts on a shared branch get reported to the
   owner, not resolved unilaterally.
2. **Read both intents**: `git log --merge -p -- <file>` for each conflicted
   file — what did each side change and why (commit messages are evidence).
   Conflict markers show the what; the commits show the why.
3. **Resolve**: the default is both-intent-preserving — base side's change
   and branch side's change both survive, composed. When the intents are
   genuinely incompatible, the base (upstream) intent wins on shared
   surfaces and the branch adapts, and the override is reported with its
   reason.
4. **Validate**: run the project's checks (build/test/lint at minimum) on
   the resolved tree. A resolution that compiles but breaks a test took the
   wrong side somewhere.
5. **Finalize**: commit the resolution with a message naming what each side
   wanted. No force-push to shared branches, ever; a rebased own-branch
   uses `--force-with-lease`.

## Rules

- Never resolve by "take ours/theirs" wholesale; that is choosing a winner,
  not resolving.
- Generated files (lockfiles, snapshots) regenerate rather than
  hand-merge.
- The resolution commit's message states the two intents it composed —
  the next archaeologist (`why`) will need it.
