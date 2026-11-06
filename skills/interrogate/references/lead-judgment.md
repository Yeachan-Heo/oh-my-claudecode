# Lead Judgment Framework

How the lead session filters, ranks, and dismisses reviewer findings.
Adapted from pstack's lead-judgment reference (see docs/CREDITS.md).

## Filtering Principles

### Nitpick Gravity

Reviewers, especially adversarial ones, tend to fill their review. If they
don't find critical issues, they'll inflate nits to fill the space. If a
reviewer's findings are all nits and style preferences, the code is probably
fine. Say so.

### Hypothetical vs. Actual

"What if someone passes null here?" is only a finding if the caller can
actually pass null. Trace the call site. If the input is validated upstream
or the type system prevents it, dismiss the finding. Reviewers working from
a diff can't always see the full call chain. You can.

### Premature Abstraction Warnings

Reviewers often suggest extracting functions or adding abstractions. Does
this code need to change in a second way? If not, the abstraction is
premature. Simple inline code that works beats a clean abstraction that's
overkill for the current scope.

### "I Would Have Done It Differently"

The most common false positive in code review. A finding that amounts to
"I prefer a different approach" is not a bug and not actionable unless the
reviewer shows a concrete problem with the current approach. Dismiss these,
and say why.

### Missing Context Signals

Watch for findings that reveal the reviewer didn't understand the context:
- Suggesting changes to code the author didn't write or modify
- Flagging patterns that are consistent with the rest of the codebase
- Recommending approaches that conflict with known constraints

These are honest mistakes from limited information. Dismiss gracefully.

## When Reviewers Are Right

Don't dismiss findings just because they're uncomfortable:

- Multiple models flag the same issue independently (consensus signal)
- The finding identifies a concrete execution path, not a hypothetical
- The finding reveals a gap in your mental model of the code
- You read the finding and think "...yeah, actually"

Be especially careful about dismissing security findings and correctness
bugs.
