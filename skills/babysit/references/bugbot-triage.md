# Bugbot Triage

How to triage automated review-bot findings. Adapted from pstack's
bugbot-triage reference (see docs/CREDITS.md).

Review bots catch real bugs AND file noise on the same PR. Each finding is
assessed on its merits, never bulk-accepted or bulk-dismissed.

## Classification

For each bot finding, choose one:

### Fix

A real issue. Trace the call site to confirm the bot's claim is reachable.
Name the lane (`debugger` or `executor`) and push the fix.

Signals:
- The finding identifies a concrete execution path with real inputs
- You read the finding and think "...yeah, actually"
- Multiple review bots or the human reviewer flagged the same issue

### Dismiss

Not an issue. Reply with the concrete reason it isn't.

Signals:
- The caller is validated upstream or the type system prevents the input
- The pattern is consistent with the rest of the codebase (the bot doesn't
  know that)
- The finding is a style preference or "I would have done it differently"
- The hypothetical requires an input that cannot reach this code

### Ask

A genuine product or preference call only the owner can make.

Signals:
- Two valid approaches with different tradeoffs
- A scope question the brief didn't answer

## Rules

- Never bulk-dismiss bot findings without reading each one.
- Never bulk-accept bot findings without tracing each call site.
- A dismissal carries a concrete reason, never a shrug.
- Bot findings about security and correctness deserve more scrutiny before
  dismissal, even when they look like noise.
