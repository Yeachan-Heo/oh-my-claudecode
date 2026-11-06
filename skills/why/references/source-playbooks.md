# Source Playbooks

Concrete procedures for querying each evidence source during a `why`
investigation. Use the ones that apply; skip the rest. Adapted from pstack's
source playbooks (see docs/CREDITS.md).

## Git archaeology

```bash
git log --follow -p -- <file>
git log -S "<search string>" --all
git blame -L <start>,<end> -- <file>
git show <commit>
git log --oneline --since="<date>" --until="<date+month>"
```

Look for: the commit that introduced the pattern, its message (the "why"),
its siblings, and any follow-up fixes.

## Linked issues and PRs

```bash
gh issue list --search "<module or function name>" --state all
gh pr list --search "<module or function name>" --state all
gh issue view <N> --comments
gh pr view <N> --comments
```

Look for: acceptance criteria, rejected alternatives, reviewer pushback,
scope reduction, and linked tracking issues.

## Observability sources

Search error trackers and APM tools for error classes and messages the
target handles. Check first seen, last seen, release correlation, and
frequency trajectory.

## Design docs and ADRs

Check `docs/`, `adr/`, or equivalent directories. Read the "Rejected"
section — what was NOT chosen and why is often more informative.
