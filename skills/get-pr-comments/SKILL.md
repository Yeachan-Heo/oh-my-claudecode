---
name: get-pr-comments
description: "Fetch and triage review threads on a PR: threads deduped with resolution state, each with a fix/dismiss/ask recommendation, bot findings read skeptically. Before addressing review feedback."
aliases: []
metadata:
  credits:
    review-comment-triage: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Get PR Comments

Bring the review surface into one list a human (or a fix lane) can act on.

## Workflow

1. **Fetch**: `gh pr view <n> --comments` for top-level,
   `gh api --paginate repos/{owner}/{repo}/pulls/{n}/comments` for inline
   review comment bodies, and `gh pr view <n> --json reviews` for whole-review
   bodies — all three surfaces are needed, and every page of the inline list
   is required. A `CHANGES_REQUESTED` review with only an overall body and no
   inline comments appears in `reviews` alone, so skip it and triage can miss
   a blocking gate. Resolution state is not on those REST objects:
   fetch threads with `isResolved` through the GraphQL API — paginate with
   `pageInfo { hasNextPage endCursor }` until `hasNextPage` is false
   (`reviewThreads(first: 100, after: $cursor)`; `{n}` above is the PR
   number) so resolved threads beyond the first page can actually be folded.
2. **Dedupe into threads**: one thread per root comment, replies nested;
   an overall review body that requests changes is its own thread (state,
   author, body) even when it carries no inline comments; resolved threads
   folded to a count unless the user asks for all.
3. **Summarize each open thread**: author, file:line, the request in one
   sentence, and a triage recommendation:
   - **fix** — a real issue; name the lane (`executor`, `debugger`)
   - **dismiss** — not an issue; the concrete reason it is not
   - **ask** — a genuine product/preference call only the owner can make
4. **Bot comments get a skeptical read**: review bots catch real bugs and
  file noise on the same PR. Each bot finding is assessed on its merits;
  dismissal carries a concrete reason, never a shrug.

## Rules

- Every recommendation names its thread; nothing silently dropped.
- "Address the review comments" hands this list to `babysit` or `execute`;
  this skill reports, it does not edit.
- Reviewer intent is quoted verbatim when the interpretation matters
  (`why` skill epistemics).
