# ADR: Durable Orchestration Graph V1

- **Status:** Accepted for v1
- **Decision scope:** Explicit, human-approved, crash-resumable control flow for long-running development work

## Decision

OMC will add Graph as a separate top-level orchestration runtime, invoked explicitly in session with:

```text
/oh-my-claudecode:graph <development goal>
```

Graph turns the goal into a typed execution descriptor whose approved revisions are immutable. It renders that descriptor for inspection and requires human approval of the exact revision ID and hash before any node may run. The approved graph, transition ledger, current projection, claims, selected routes, join tokens, and revision history live together in one authoritative, session-scoped `graph-state.json` transaction object.

Graph does not replace Ralph or widen Autopilot. Ralph remains a persistent implementation and verification loop. Autopilot remains its established staged autonomous workflow. A Graph `agent` node may perform bounded local iteration, but Graph remains the only top-level scheduler and records which node is active, which edge was selected, and what is ready next.

## Drivers

- Long-running tasks lose their global shape when the next action exists only in an agent's conversation context.
- Parallel branches, conditional remediation, human gates, and crash recovery require explicit persisted control state.
- Completed work must survive driver or agent interruption without relying on prompt memory.
- Structural changes discovered during execution need reviewable, immutable revisions rather than silent graph mutation.
- Existing Ralph and Autopilot users require compatibility, not a migration to a new runtime.

## Descriptor, approval, and revisions

The v1 descriptor declares stable node IDs, node kinds, entry nodes, typed edges and route labels, joins, concurrency, bounded back-edges, and terminal verification responsibility. Its canonical JSON is hashed with SHA-256; mutable attempts, outputs, owners, and timestamps are excluded from the descriptor hash.

The approval view identifies every node, command, route, join, return bound, concurrency limit, and terminal verification node. Drafting and validation may occur before approval, but dispatch may not. Approval binds to the exact revision ID and descriptor hash.

Agents may propose structural patches but may not apply them. A proposal pauses new dispatch, waits for old claims and reconciliation to settle, and requires human approval of a new immutable revision. The ledger retains earlier descriptors, results, and evidence; completed node IDs cannot be silently reused.

## Nodes and routes

V1 has four built-in node kinds:

| Node | Responsibility |
| --- | --- |
| `agent` | Perform bounded delegated development work and return a structured result. |
| `command` | Run a permission-governed command or automated test and report structured evidence. |
| `human-approval` | Wait durably for an explicit human decision. |
| `join` | Deterministically synchronize the selected branches of one fan-out traversal. |

Edges support fixed continuation, declared conditional routes, parallel fan-out/fan-in, and bounded returns to an earlier node. V1 fork/join regions are structured and non-overlapping: every fan-out owns one join, and nested or crossing open regions are rejected. Edge conditions are declared route labels, not arbitrary executable expressions.

## State, commits, and recovery

The scheduler commits a node result, selected route, traversal counters, resulting readiness, and join state in one compare-and-swap transaction. A monotonic sequence, revision/hash fence, transition ID, activation ID, attempt ID, and claim lease prevent duplicate or stale work from winning after recovery.

This provides exactly-once committed scheduler transitions. It does **not** provide exactly-once external side effects. Side-effect-free work and work with durable idempotency keys may be retried after an expired lease. An ambiguous external effect enters visible reconciliation and requires evidence or a human decision before the graph continues.

Recovery rebuilds readiness from the approved revision and committed history. Successful committed nodes are not rerun. Logs, HUD projections, and exports are disposable views; they are not recovery authorities.

## Runtime ownership and lifecycle

Graph is mutually exclusive with other root persistent workflow owners, including standalone Ralph and Autopilot. A child adapter cannot release the Graph root or become a second scheduler.

Ordinary Graph cancellation maps to `pause`: new dispatch stops, claims and children are fenced or drained, durable state becomes `paused`, and root control is released. `resume` reacquires the same session, run, and revision with a new ownership nonce; it does not create a replacement run. Permanent termination is the explicit `abandon` operation, which requires exact run/revision confirmation, records terminal `cancelled`, and retains the full ledger and evidence. Destructive purge is outside v1.

The in-session skill owns descriptor drafting, exact-revision questions, node dispatch, and result reporting. Terminal automation may use guarded `omc graph` operations, but those operations are a state-machine boundary, not a general task executor or a raw state editor.

## Public-state handling

Generic state surfaces may read, list, report status, and render bounded summaries for Graph. They may not replace or delete Graph state. Generic `state_write(graph)` is unavailable; `state_clear(graph)` returns `guarded_mode`; `state_clear(all)` skips Graph and reports the skip. A force flag does not bypass these protections. Pausing and abandoning use Graph-specific atomic operations.

## Platform boundary

Graph v1 execution requires Linux with `/proc` process identity and owner-fenced `flock`. An unsupported runtime fails before reserving control or creating or mutating Graph state. Pure descriptor validation and scheduler logic may remain portable and tested elsewhere.

## Alternatives

### Extend Team task dependencies

Rejected. Team task files do not provide graph-wide atomic route selection, join cohorts, immutable revisions, claim fencing, or a complete recovery ledger.

### Encode Graph as an Autopilot named profile

Rejected. Named profiles intentionally compose a closed set of linear Autopilot stages. [ADR 03487](./03487-named-autopilot-stage-profiles.md) explicitly defers branches, loops, DAGs, and arbitrary workflow engines to a separate architecture.

### Implement Graph only in prompts

Rejected. Prompt memory cannot prove atomic resume, prevent stale completion, or distinguish committed work from an interrupted external effect.

### Adopt a general graph engine or plugin DSL

Rejected for v1. OMC needs a small local scheduler with its own state, ownership, and recovery contracts. A dependency or public extension surface would broaden compatibility and trust requirements before those contracts are proven.

## Why chosen

A separate deterministic core keeps explicit control flow and durable recovery testable without changing Ralph or Autopilot semantics. Human-approved immutable revisions make execution inspectable, while the single transaction object keeps structure, progress, and evidence consistent after interruption.

## Consequences

Graph adds more ceremony than a loop: users must inspect the graph, approve revisions, and reconcile ambiguous side effects. In exchange, long-running branching work has a durable global plan, explicit parallelism, bounded remediation paths, and recoverable progress.

Graph-specific state and ownership paths require parity across plugin and standalone-installed hooks. Generic state mutation remains intentionally narrower than for older modes.

## Migration and compatibility

There is no migration for existing Ralph, Autopilot, or Team workflows. Graph activates only through its explicit skill entrypoint; bare natural-language mentions of "graph" do not select the mode. Existing invocations and state identities remain unchanged.

## Follow-ups and explicit deferrals

V1 does not include a visual editor, a public stable authoring DSL, plugin-defined node kinds, arbitrary executable edge code, distributed or cross-repository scheduling, nested or overlapping fork/join regions, destructive state purge, silent agent graph mutation, or exactly-once external side effects.
