---
name: babysit
description: Drive an open PR to merge-ready — watch checks and review state with the watch-pr verdict policy (green is not safe), fix CI failures and address review comments through the right lane, record verification verdicts in the ledger, and never merge on its own. Use for "get this PR green", "address the review comments", or "babysit PR #N".
aliases: []
metadata:
  credits:
    babysit-workflow: pstack
    watch-pr-policy: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Babysit

Keep an open PR moving toward merge-ready: watch its checks, review threads,
and mergeability; act on what blocks them; and report evidence. The PR's
merge stays with the human — green is not safe, and this skill never merges,
rebases, or force-pushes.

## When to use

- "get this PR green", "babysit PR #N", "address the review-bot comments"
- the user wants a PR they opened earlier driven to merge-ready while they
  are away

## When not to use

- merely opening a PR (no monitoring is implied)
- the user asks to land or ship a green stack — that decision belongs to the
  user; report merge-readiness and stop

## Loop

Declare the mode before the first poll: which PR, and whether bot comments
are in scope.

1. **Read state** via `gh`: `gh pr view <N> --json state,headRefOmit,mergeable,reviewDecision,isDraft,headRefOid`
   and `gh pr checks <N> --json` (when supported) or the plain table. Confirm
   the first read reports the requested PR before acting on it.
2. **Apply the watch-pr verdict policy** (`src/features/watch-pr/policy.ts`
   semantics, embedded below). Do not eyeball; classify.
3. **Act on the verdict**:
   - failing check → `fix-ci` (classify real/flaky/environmental, then fix)
   - requested changes → `get-pr-comments` to triage threads, then address
     each through the review lane; reply to threads you resolve; dismiss
     bot noise with a concrete reason instead of churning code
   - conflicts → `fix-merge-conflicts` when the branch is ours to resolve;
     otherwise report to the branch owner
   - mergeability unknown → wait one interval and re-read; it is never an
     error
   - draft or missing review → report what is missing; do not self-approve
4. **Record the verdict** in the verification ledger
   (`.omc/state/verification-ledger.tsv`) when a check cycle completes: PR,
   head SHA, verdict word, evidence command. One row per observed verdict
   transition, never per poll.
5. **Report**: verdict, what changed since the last poll, what is still
   blocking, and the exact commands you ran. Every claim carries its
   evidence.

Poll with `gh pr checks --watch` or a sleep loop at a stated interval; state
the interval. Stop when the PR is merge-ready, merged, closed, or the user
says stop, and say which.

## The verdict policy

Classification order, first match wins:

- conflicts → **blocked** (merge conflicts; the branch owner decides the resolution)
- any failed check → **blocked** (fix lane)
- changes requested → **blocked** (review lane)
- review required or missing approval → **blocked** (needs a human reviewer; never self-approve)
- mergeability not yet computed → **waiting** (re-poll; not an error)
- pending checks → **waiting**
- no checks configured → **waiting** until the same head SHA has shown no
  checks for a 60-second confirmation window; only then is the absence
  real. A first sighting of "no checks" is never readiness.
- otherwise → **ready**, with the head SHA recorded in the proof

"Ready" means the gates you can see are green. It is not permission to
merge, and it is not verification of the change itself — that evidence
belongs to `verify` and the ledger.

## Rules

- Never merge, never rebase, never force-push, never approve a review.
- A review-bot comment gets a skeptical read: real bugs are fixed, non-issues
  are dismissed with a concrete reason.
- One fix lane at a time; wait for its push before re-classifying.
