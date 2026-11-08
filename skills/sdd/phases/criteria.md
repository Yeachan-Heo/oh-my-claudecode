
# Acceptance Criteria Skill

Translate the resolved spec into acceptance criteria using EARS templates.

Pipeline position: proposal → spec → **criteria** → rules → review → tasks

# Role

You translate the spec into independently testable, implementation-agnostic acceptance criteria. You do not invent
product decisions. If a behavior is too ambiguous for a testable criterion, route the gap back to the spec step.

# Inputs

- Resolved spec: `spec/<slug>/spec.md` (primary source; "Behaviors to verify" is the contract)
- Proposal: `spec/<slug>/proposal.md` (reference)

Spec takes precedence over proposal where they disagree.

# EARS Templates

Use the smallest template that fits the requirement. Do not invent new templates.

**Ubiquitous** (always-true behavior):
`The <system> shall <response>.`

**Event-driven** (triggered by an event):
`When <trigger>, the <system> shall <response>.`

**State-driven** (active during a state):
`While <state>, the <system> shall <response>.`

**Optional feature** (applies when a feature is included):
`Where <feature is included>, the <system> shall <response>.`

**Unwanted behavior** (explicit handling of an undesired trigger):
`If <trigger>, then the <system> shall <response>.`

**Combined** (state plus event):
`While <state>, when <trigger>, the <system> shall <response>.`

Example:

```
If a CSV row is missing a required field, then the importer shall skip the row, log a warning with row number and field name, and continue processing.
```

# Patterns

**Boundary** (any bounded value): write three criteria, one within bounds, one at the boundary, one beyond.

**Error**: use the Unwanted behavior template. Specify what the system shall do (not just what it won't) and atomicity (
all-or-nothing vs partial with reported failures).

**State transition**: one criterion per transition.
`While in state A, when <event> occurs, the <system> shall transition to state B and emit event X.`

**Negative** (authz, side-effect paths): use the Unwanted behavior template and state the prohibited outcome explicitly.
`If <unauthorized trigger>, then the <system> shall respond with 403 and not produce, log, or stage X.` The "and not"
half is what makes it negative.

**Non-functional** (performance, security, observability, accessibility, compatibility): same templates with thresholds
and load context.
`When 100 concurrent requests are sustained for 60s, the <system> shall return p95 < 200ms with zero 5xx.`

# Anti-patterns

**Bad:** `SHALL store data in PostgreSQL using JDBC` → **Better:** `SHALL persist such that data survives application restart`. Don't prescribe implementation.

**Bad:** `... SHALL load config AND init cache AND connect DB` → **Better:** three separate criteria. Compound criteria aren't independently testable.

**Bad:** `SHALL be fast / intuitive / work correctly` → **Better:** `SHALL return p95 < 200ms`. Subjective adjectives aren't testable.

**Bad:** `WHEN user clicks the blue button on the bottom-right` → **Better:** `WHEN user submits the registration form`. Don't prescribe UI.

# Granularity

One observable outcome per criterion. If the SHALL clause splits naturally or contains "and" between distinct outcomes, split.

# Traceability

Every criterion has:
- Stable ID: `AC-1`, `AC-2`, ... in document order
- `Covers:` line listing the behavior(s) it addresses, using B-N IDs from the spec

If a criterion covers spec content outside "Behaviors to verify" (e.g., an explicit assumption that doesn't appear as a
B-N), reference by section heading and a distinguishing phrase, e.g.
`Covers: Resolved ambiguities, "currency conversion at order time"`.

# Coverage Rule

Every B-N in the spec must be covered by at least one AC. If a spec item outside "Behaviors to verify" implies runtime
behavior and no AC covers it, flag it as a spec gap. Do not silently invent the behavior.

# Route-Back Threshold

Route back to the spec step when any of:

- At least one behavior cannot be phrased as a testable trigger/response without inventing product decisions
- At least two behaviors share the same gap (suggests systemic ambiguity)
- A boundary value, error path, or state transition is implied but not specified

A single missing detail you can resolve by reading the codebase is not a route-back; resolve it and note the source.
Don't pretend to understand to avoid the loop.

# Success Criteria

Complete only when ALL hold:

- Every B-N is covered by at least one AC
- Every bounded value has the three-criterion boundary pattern
- Every error path uses the Unwanted behavior template with behavior, atomicity, and observable response
- Every state transition has a transition AC
- Every authorization-relevant path has a negative AC
- Non-functional categories considered (covered or recorded under "Coverage exclusions")
- Every AC uses an EARS template, has one SHALL outcome, avoids implementation prescription, and contains no rationale
- Every AC has an ID and `Covers:` reference

Run a verification pass before writing. Do not write a partial file.

# Output

Write to `spec/<slug>/criteria.md`:

```
# Acceptance Criteria: <Feature>

## Functional

### AC-1: <title>
**Covers:** B-N[, B-M ...]

<EARS statement>

### AC-2: ...

## Non-functional

### AC-N: ...

## Coverage exclusions

- <non-functional category>: <reason for not covering>
```
