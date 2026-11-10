# Merge Safety

Rules that prevent merge accidents. Adapted from pstack's merge-safety
reference (see docs/CREDITS.md).

## Never do these

- Never merge a PR whose base moved after its verdict was earned — re-run
  the checks first.
- Never force-push to a shared branch.
- Never merge with unresolved review threads unless the user explicitly
  said to.
- Never merge when the head SHA differs from the one the green checks ran
  on.

## Always do these

- Verify the head SHA matches the last green run before merging.
- Cancel pending auto-merges before any chain rebase or force-push.
- Land bottom-up in a stack: PR 1 first, then rebase the rest.
- Confirm the merge in the destination branch's history before advancing
  to the next PR in the stack.
