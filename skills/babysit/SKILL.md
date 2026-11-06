---
name: babysit
description: "Drive an open PR to merge-ready on the watch-pr verdict policy — watch checks and review state, fix CI, address comments; never merges, rebases, or force-pushes. For 'get this green' or 'babysit PR #N'."
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

1. **Read state** via `gh`, always naming the upstream repository:
   `gh pr view <N> --repo <OWNER/REPO> --json state,mergeable,mergeStateStatus,reviewDecision,isDraft,headRefOid,headRefName,baseRefName`
   and `gh pr checks <N> --repo <OWNER/REPO> --json name,bucket` (bucket is `pass`/`fail`/`pending`/`skipping`/`cancel`). A bare `<N>` resolves against whatever repository the current checkout belongs to — in a fork clone that is the fork, not the upstream PR being polled. Carry `baseRefName` with the head identity: the branch-protection lookup and the CI/conflict lanes integrate against the base the PR targets, not the checkout's default branch.
   Normalize before classifying: `mergeable` arrives uppercased
   (`MERGEABLE`/`CONFLICTING`, `UNKNOWN` or empty while GitHub computes it),
   and `reviewDecision` is an **empty string** when no review exists — not
   `none`. Exit codes: `gh pr checks --json` exits 0 even when checks
   **fail** — judge by `bucket`, never the exit code; with no checks
   configured it exits 1 printing "no checks reported", which is the
   no-checks path, not an error.
   `mergeStateStatus` is an aggregate merge gate; classify `BLOCKED` or
   `BEHIND` as blocked and `UNKNOWN` as waiting before allowing ready. Confirm the first
   read reports the requested PR before acting on it.
2. **Apply the watch-pr verdict policy** (`src/features/watch-pr/policy.ts`
   semantics, embedded below). Do not eyeball; classify.
3. **Act on the verdict**:
   - failing check → `fix-ci` (classify real/flaky/environmental, then fix; pass the target repo, PR number, head SHA, and base branch)
   - requested changes or unresolved review threads → `get-pr-comments` to
     triage threads, then address each through the review lane; reply to
     threads you resolve; dismiss bot noise with a concrete reason instead
     of churning code. Read the threads surface (`comments`/`reviews` via
     the get-pr-comments fetch) even when `reviewDecision` is empty or
     `approved` — a non-blocking review or a comment after approval leaves
     the decision clean while real threads stand — and never report `ready`
     while an in-scope thread is untriaged
   - conflicts → `fix-merge-conflicts` **in its no-rebase mode**: resolve
     with a merge commit only. Never rebase and never force-push here —
     this constraint overrides that skill's own-branch rebase option,
     because babysit's contract forbids both. If the branch is not ours to
     resolve, report to the branch owner instead
   - mergeability unknown → wait one interval and re-read; it is never an
     error
   - draft or missing review → report what is missing; do not self-approve
   - aggregate `BLOCKED` without requested changes → inspect unresolved review
     threads with `get-pr-comments <N>` before reporting an unactionable block
4. **Ledger discipline**: watch verdicts (`ready`/`waiting`/`blocked`/`gone`)
   are gate states, not verification — never write them into the
   verification ledger, whose vocabulary is separate. Append a verification
   ledger row (at the writer's canonical path under OMC's state root) only
   when *you* executed a check
   yourself — e.g. a `fix-ci` rerun went green (`unit-test-verified`, with
   the command as evidence). One row per executed check, never per poll.
5. **Report**: verdict, what changed since the last poll, what is still
   blocking, and the exact commands you ran. Every claim carries its
   evidence.

Poll with `gh pr checks <N> --watch` or a sleep loop at a stated interval; state
the interval. Stop when the PR is merge-ready, merged, closed, or the user
says stop, and say which.

## The verdict policy

Classification order, first match wins:

- conflicts, `mergeStateStatus=BLOCKED`, `BEHIND`, or `DIRTY` → **blocked** (merge conflicts or another aggregate gate; the branch owner decides the resolution)
- any failed check → **blocked** (fix lane)
- any canceled check → **blocked** (bucket `cancel`; rerun or clear it — a canceled check is not a green gate)
- changes requested → **blocked** (review lane)
- branch protection or rulesets require reviews, and approval is missing → **blocked** (needs a human reviewer; never self-approve)
- mergeability or `mergeStateStatus=UNKNOWN` or `DRAFT` → **waiting** (re-poll; not an error). `HAS_HOOKS` is not a wait: GitHub defines it as mergeable with passing commit status and pre-receive hooks — the hooks belong to the merge attempt, so an otherwise green PR with `HAS_HOOKS` classifies normally
- pending checks → **waiting**
- no checks configured → **waiting** until the same head SHA has shown no
  checks for a 60-second confirmation window; only then is the absence
  real. A first sighting of "no checks" is never readiness. Before serving
  that window, check whether the repo has PR-triggered workflows at all
  (`.github/workflows/`, or a run on another PR): when workflows exist but
  this head shows none — observed in the wild on path-filtered and
  skipped-event pushes — cross-check `gh run list --branch <head>`; a
  persistent zero-run anomaly is **blocked (investigate: path filters,
  base mismatch, skipped events)**, not a no-checks repo.
- otherwise → **ready**, with the head SHA recorded in the proof

"Ready" means the gates you can see are green. It is not permission to
merge, and it is not verification of the change itself — that evidence
belongs to `verify` and the ledger.

## Rules

- Never merge, never rebase, never force-push, never approve a review.
- A review-bot comment gets a skeptical read: real bugs are fixed, non-issues
  are dismissed with a concrete reason.
- One fix lane at a time; wait for its push before re-classifying.
