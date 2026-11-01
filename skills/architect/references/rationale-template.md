# Rationale Template

The written record of a design decision. Fill during the decision phase;
the implementation reconciles against it. Adapted from pstack's rationale
template (see docs/CREDITS.md).

## Template

```markdown
## Decision: <one-sentence summary>

### Context
What problem requires this design? What are the constraints?

### Options considered

#### Option A: <name>
- Core types: <the data shapes>
- Module boundary: <what it owns and delegates>
- API surface: <what callers see>
- Invariant preservation: <how each invariant holds>

#### Option B: <name>
(same structure)

### Decision
<option name>, because <the deciding criterion beat the others>.

### Rejected alternatives and why
- <option>: <the specific reason it lost — not "worse" but *what* was worse>

### Accepted deviations
Deviations from this design made during implementation:
- <deviation>: <what changed vs the sketch>, accepted by <source>

### Invariants the implementation must preserve
1. <invariant>: <how the design preserves it>
```

## Rules

- "Worse" is not a reason — the specific loss is.
- If a deviation isn't in the register, it's a bug, not a choice.
- Every invariant must be checkable.
