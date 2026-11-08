---
name: blast-radius
description: "Map what a change could break beyond the diff — dependents found by search and AST, classified certain/likely/unlikely — and prove the certain and likely ones by running their checks. Before risky refactors or signature changes."
aliases: []
metadata:
  credits:
    impact-analysis: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Blast Radius

The diff tells you what changed; it does not tell you what breaks. This
skill maps the dependents of a change and proves what it can — by running
code, not by reasoning alone.

## When to use

- a signature, data shape, or behavior other code calls changed
- a dependency bump, config default flip, or migration
- the user asks "what could this break?"

## Workflow

1. **Name the change surface**: exported symbols, persisted formats, CLI
   flags, API contracts, timing assumptions. List them explicitly.
2. **Map dependents**: grep for each symbol; where available use AST search
   (`ast_grep_search` MCP tool) to catch structural uses text search misses;
   follow re-exports one more hop than feels necessary.
3. **Classify each dependent**:
   - **certain** — calls the changed surface directly
   - **likely** — consumes a type or format the change touches
   - **unlikely** — shares a module but not the surface
4. **Prove what you can**: for every certain and likely impact, run the
   exact check that would catch the break — its test, its typecheck, its
   build, or a one-off command exercising the path. Report real output.
   Impacts you cannot execute a check for are listed as **unverified**, not
   as safe.
5. **Report**: the surface, the dependent counts by class, per-impact
   verification with evidence, and the unverified remainder named honestly.

## Rules

- "It should be fine" is not a classification; every claim is certain,
  likely, unlikely, or unverified, with its reason in the same sentence.
- Reasoning reduces the search space; execution settles the verdict.
- The report never edits code; fixes found this way go through `execute`.
