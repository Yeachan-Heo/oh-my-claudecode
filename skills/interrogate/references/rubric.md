# Review Rubric

Review through whichever lenses are relevant. Not every lens applies to every
change. Adapted from pstack's review rubric (see docs/CREDITS.md).

## Correctness

Does the code actually do what the intent says it should?

- Edge cases: empty inputs, nil/undefined, boundary values, concurrent access
- Error handling: are errors caught, propagated, or silently swallowed?
- Off-by-one, type coercion, integer overflow, string encoding
- State management: race conditions, stale closures, dangling references
- Idempotency: what happens if this operation runs twice, or if a previous
  run crashed halfway? If the answer is "it depends on what state was left
  behind," a reconciliation step is missing.
- Concurrency: if multiple actors can touch the same mutable state, is
  access serialized structurally, or by conventions that won't hold?

## Security

- Does the change introduce a new attack surface?
- Are inputs validated at the boundary, or trusted from internal callers?
- Are secrets, tokens, or PII exposed in logs, error messages, or responses?
- Is authorization checked on every path, or only on the entry point?
- Are third-party inputs treated as hostile?
- User input flowing to dangerous sinks (SQL, shell, eval, innerHTML)
  without sanitization

## Structural Integrity

Does the code fit well into the system it's part of?

- Boundary discipline: is validation at system boundaries, or scattered
  through business logic?
- Abstraction level: is the code mixing high-level orchestration with
  low-level detail?
- Coupling: does this change introduce dependencies that will make future
  changes harder?
- Data model fit: do the data structures match the actual access patterns?
- Bolted-on vs. integrated: if the new requirement had been known from the
  start, would the code look like this?
- Legacy dual-paths: does the change introduce a new API while keeping the
  old one alive? If no external consumers, migrate and delete in the same
  wave.

Don't penalize simple code for lacking abstraction. Premature abstraction is
worse than duplication.

## Verification

Can you tell that this code works from reading it?

- Are there tests? Do they test behavior or implementation details?
- Are there assertions that would catch regressions?
- If this is a bug fix: is there a test for the bug?
- Check the real thing, not a proxy.
- For delegated or async work: does the code verify actual output artifacts,
  or does it trust self-reports?

## Complexity Budget

Is the complexity justified by what the code accomplishes?

- Code that could be simpler without losing correctness or clarity
- Abstractions that serve only one call site
- Dead code, unused imports, vestigial parameters
- Over-engineering: "just in case" code paths with no current callers
- Obsolete compatibility paths kept alive past their need
- Does the user experience justify the complexity?

Simpler is better unless simpler is wrong.

## Instructions where structure would be better

If the fix is a comment saying "don't do X" or a convention someone has to
remember, ask whether it could instead be a type constraint, a lint rule, or
a runtime check that makes the wrong thing impossible.
