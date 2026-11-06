# Design Red Flags

Signals that a design is likely wrong, incomplete, or will cause problems.
Use during comparison of competing designs. Adapted from pstack's
design-red-flags reference (see docs/CREDITS.md).

## Structural

- **Shallow module**: exposes a large interface while hiding little
  complexity. Callers coordinate several methods for one operation. Prefer
  a simple interface backed by substantial behavior.
- **Information leakage**: a representation or policy detail appears in
  more than one place. Public re-exports of transport types are leakage.
  Parse external data into domain types behind the interface.
- **Temporal decomposition**: modules organized by execution order instead
  of the knowledge they own. Group code around domain knowledge.
- **Pass-through method**: forwards the same arguments with the same
  shape. Adds a layer without hiding complexity. Remove it or move
  responsibility.
- **Split ownership**: more than one module writes the same state. Give
  each piece of state one owner.

## Behavioral

- **"It should never happen" guards without a recovery path** — if it
  truly never happens, the check is dead code; if it can, the guard is
  silently swallowing a bug.
- **A mutation callers must remember to undo** — wrap it in a scope guard;
  do not document the requirement.
- **Config read at import time** — can't be changed at runtime or in tests.
- **Catch-retry loop** — hides real bugs; use bounded retry with backoff.

## Operational

- **Migration without partial-failure handling** — what if the process
  crashes between steps?
- **New external dependency without a fallback** — what when it's down?
- **Cache without invalidation strategy** — the first stale-read bug costs
  more than the cache saved.
- **New endpoint without rate limiting** — the first abusive client takes
  the service down.
- **Deleting an old API without checking all callers** — grep is not
  enough; use the type checker.
