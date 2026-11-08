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

1. **Read state** via `gh`: `gh pr view <N> --json state,mergeable,mergeStateStatus,reviewDecision,isDraft,headRefOid,headRefName`
   and `gh pr checks <N> --json name,bucket` (bucket is `pass`/`fail`/`pending`/`skipping`/`cancel`).
   Normalize before classifying: `mergeable` arrives uppercased
   (`MERGEABLE`/`CONFLICTING`, `UNKNOWN` or empty while GitHub computes it),
   and `reviewDecision` is an **empty string** when no review exists — not
   `none`. Exit codes: `gh pr checks --json` exits 0 even when checks
   **fail** — judge by `bucket`, never the exit code; with no checks
   configured it exits 1 printing "no checks reported", which is the
   no-checks path, not an error.
   Treat aggregate `mergeStateStatus=BLOCKED` as blocked and `UNKNOWN` as waiting before allowing ready. Confirm the first read reports the requested PR before acting on it.
2. **Apply the watch-pr verdict policy** (`src/features/watch-pr/policy.ts`
   semantics, embedded below). Do not eyeball; classify.
   Determine `reviewRequired` from the repository's branch-protection
   settings (for example, `gh api repos/OWNER/REPO/branches/BRANCH/protection`
   and the `required_pull_request_reviews` field); a ruleset that requires
   reviews independently of classic branch protection counts the same way.
   Pass that boolean into the
   policy; do not treat an empty review decision as a blocker when the branch
   does not require approval.
3. **Act on the verdict** — every lane gets the polled identity: pass the
   repo and PR number explicitly and verify the checkout sits on that PR's
   head before mutating anything. Bare `gh pr checks`/`gh pr view` select
   whatever PR owns the current branch, which need not be the one babysit
   polls.
   - failing check → `fix-ci` (classify real/flaky/environmental, then fix; pass the target repo, PR number, head SHA, and base branch)
   - requested changes or unresolved review threads → `get-pr-comments` on
     the polled repo and PR number — triage threads, then address each
     through the review lane; reply to
     threads you resolve; dismiss bot noise with a concrete reason instead
     of churning code. Read the threads surface (`comments`/`reviews` via
     the get-pr-comments fetch) even when `reviewDecision` is empty or
     `approved` — a non-blocking review or a comment after approval leaves
     the decision clean while real threads stand — and never report `ready`
     while an in-scope thread is untriaged
   - conflicts → `fix-merge-conflicts` **in its no-rebase mode**, run on the
     polled PR's owned checkout: resolve
     with a merge commit only. Never rebase and never force-push here —
     this constraint overrides that skill's own-branch rebase option,
     because babysit's contract forbids both. If the branch is not ours to
     resolve, report to the branch owner instead
   - mergeability unknown → wait one interval and re-read; it is never an
     error
   - draft or missing review → report what is missing; do not self-approve
4. **Ledger discipline**: watch verdicts (`ready`/`waiting`/`blocked`/`gone`)
   are gate states, not verification — never write them into the
   verification ledger, whose vocabulary is separate. Append a verification
   ledger row (the writer's canonical path under OMC's state root) only
   when *you* executed a check
   yourself — e.g. a `fix-ci` rerun went green (`unit-test-verified`, with
   the command as evidence). One row per executed check, never per poll.
   Write it through the repository writer so header creation, locking, and
   validation are enforced. Resolve the installed package root the
   figure-it-out way: plugin-root variables first, then walk the installed
   `oh-my-claudecode` package from the working directory — and report the
   resolution failure instead of skipping the write:

   ```sh
   node --input-type=module -e "const {createRequire}=await import('node:module'); const path=await import('node:path'); const {pathToFileURL}=await import('node:url'); let root=process.env.CLAUDE_PLUGIN_ROOT||process.env.OMC_PLUGIN_ROOT; if(!root){ const req=createRequire(process.cwd()+'/package.json'); for (const name of ['oh-my-claude-sisyphus','oh-my-claudecode']) { try { root=path.dirname(req.resolve(name+'/package.json')); break; } catch {} } } if(!root) throw new Error('cannot resolve the installed package root; set CLAUDE_PLUGIN_ROOT or OMC_PLUGIN_ROOT'); const {appendLedgerEntry,defaultLedgerPath}=await import(pathToFileURL(root+'/dist/features/verification-ledger/index.js').href); await appendLedgerEntry(defaultLedgerPath(),{ts:new Date().toISOString(),kind:'babysit',ref:'<N>',sha:'<HEAD_SHA>',verdict:'unit-test-verified',evidence:'<command>',verifier:'babysit'});"
   ```
   The writer owns the exact seven-column TSV layout; do not append raw rows.
5. **Report**: verdict, what changed since the last poll, what is still
   blocking, and the exact commands you ran. Every claim carries its
   evidence.

Poll with `gh pr checks --watch` or a sleep loop at a stated interval; state
the interval. Stop when the PR is merge-ready, merged, closed, or the user
says stop, and say which.

## The verdict policy

Classification order, first match wins:

- conflicts, `mergeStateStatus=BLOCKED`, `DIRTY`, or `BEHIND` → **blocked** (merge conflicts or another aggregate gate; the branch owner decides the resolution)
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
