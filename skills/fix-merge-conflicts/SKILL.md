---
name: fix-merge-conflicts
description: "Resolve merge conflicts non-interactively: start the integration, read both sides' intent from their commits, preserve both intents, validate on the resolved tree. Never force-pushes shared branches."
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
2. **Start the approved integration first**: `git merge <base>` (or the
   project's rebase convention, when the caller has not constrained it) so
   conflict markers exist. A `mergeable: conflicting` answer from the
   remote, or a clean local branch, has no `MERGE_HEAD` — `git log --merge`
   before integrating exits 128.
3. **Read both intents**: `git log --merge -p -- <file>` for each conflicted
   file once the merge is in progress — what did each side change and why
   (commit messages are evidence). Conflict markers show the what; the
   commits show the why. When the caller forbids starting a merge (e.g.
   read-only inspection), compare explicit ranges instead:
   `git log -p <base>...HEAD -- <file>`.
4. **Resolve**: the default is both-intent-preserving — base side's change
   and branch side's change both survive, composed. When the intents are
   genuinely incompatible, the base (upstream) intent wins on shared
   surfaces and the branch adapts, and the override is reported with its
   reason.
5. **Validate**: run the project's checks (build/test/lint at minimum) on
   the resolved tree. A resolution that compiles but breaks a test took the
   wrong side somewhere.
   If intent analysis, resolution, or validation cannot complete after a
   merge starts, run `git merge --abort`; after a rebase starts, run
   `git rebase --abort`. If abort is unsafe or unavailable, stop and hand off
   the repository with the active `MERGE_HEAD`/`REBASE_HEAD` and conflict list
   explicitly reported.
6. **Finalize**: for a rebase, stage each resolved file and run
   `git rebase --continue` repeatedly until `git status` shows no active
   rebase. Validate that final tree before pushing. Then commit the resolution with a message naming what each side
   wanted. No force-push to shared branches, ever; a rebased own-branch
   uses `--force-with-lease` — unless a caller (e.g. `babysit`) forbids
   rebase and force-push entirely, in which case merge-commit resolution is
   the only path.

## Rules

- Never resolve by "take ours/theirs" wholesale; that is choosing a winner,
  not resolving.
- Generated files (lockfiles, snapshots) regenerate rather than
  hand-merge.
- The resolution commit's message states the two intents it composed —
  the next archaeologist (`why`) will need it.
