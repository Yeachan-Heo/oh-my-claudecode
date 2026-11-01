---
name: stacked-delivery
description: "Deliver a queue of changes as one linear stacked PR chain — each PR lands on the last, verdicts record patch-ids, rebases trigger re-verification, and landing goes bottom-up only. For 'stack them, I'll land them' or review-gated queues."
aliases: []
metadata:
  credits:
    stacked-delivery: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Stacked Delivery

Some queues cannot merge independently — each change depends on the last —
so they ship as one stacked chain: PR 2 branches on PR 1, PR 3 on PR 2.
The chain makes review sequential and landing strictly bottom-up; this
skill keeps that honest.

## When to use

- changes depend on each other and the user chose stacking over
  independent PRs
- review gating means only the bottom PR can actually merge at a time

## When not to use

- changes are independent — parallel PRs merge faster and fail smaller
- the user wants everything in one PR — that is `execute` with a bigger brief

## Workflow

1. **Cut the stack**: one branch and PR per change, each branched on the
   last; the brief for each PR comes from `sharpen`/`architect` as usual.
   Every PR description links its parent and child.
2. **Build and verify each layer** with its own checks — a red middle PR
   blocks the whole chain, so fix forward before adding layers on top.
3. **Record patch-ids**: each verdict (from `verify`, `interrogate`, or
   review) records the head SHA it was earned on, in
   `.omc/state/verification-ledger.tsv` — the ledger's
   `sha` field. A verdict applies only to that exact patch.
4. **On rebase**: any PR whose base moved has its verdicts invalidated for
   the affected layers — re-run the checks and record fresh verdicts before
   the chain is "green" again. A stale green is the stack's most dangerous
   lie.
5. **Land bottom-up only**: the human merges PR 1; the stack rebases onto
   the new trunk; re-verify; PR 2 becomes the new bottom. This skill never
   merges — landing authority stays with the human (`babysit` rules apply).
6. **Report**: the chain shape (PR list with parent links), each layer's
   verdict and patch-id, and which layers are re-verified against the
   current trunk.

## Rules

- Never merge, rebase, or force-push shared branches on your own; rebase of
  own-branch layers uses `--force-with-lease` and says so.
- Never present a layer as green whose base moved after its verdict was
  earned — the ledger's patch-id is the truth.
- A failing layer stops the chain at that layer; layers above are
  blocked-and-waiting, not green.
