---
name: what-did-i-get-done
description: Summarize the commits you authored over a user-chosen period — grouped by theme, each group with its evidence (commit range), and honest accounting of started-but-unfinished work. Use for standups, retrospectives, or "what did I get done this week".
aliases: []
metadata:
  credits:
    authored-work-summary: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# What Did I Get Done

Summarize authored work from the record, not from memory.

## Workflow

1. **Establish identity and window**: which author(s) and what period
   (default: the last 7 days; take the user's override).
2. **Collect**: `git log --author=<you> --since=<window> --stat` across the
   repos in play; include merged PRs via
   `gh pr list --author <you> --state merged --search "merged:>=<window-start>"`
   where the user cares about review surface (`--state` defaults to `open`,
   so it must be named; `--author` needs its value).
3. **Group by theme**, not by commit: a theme line names the outcome ("auth
   retry hardening"), the commits underneath are the evidence.
4. **Count honestly**: commits, net lines, tests added. Mechanical churn
   (renames, lockfiles) is grouped separately or left out, never passed off
   as progress.
5. **Started-but-unfinished**: branches and PRs opened but not landed in the
   window, each with what remains — the section standups actually need.

## Rules

- Every theme line links its commit range; no theme without commits.
- No inflating: a revert-pair counts as zero, and that is said, not hidden.
- The summary is prose over a small table; it fits in one screen.
