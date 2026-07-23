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

Graph v1 execution is cross-platform and runs on Linux, macOS, and Windows.
Process identity pairs a pid with a process start time so a dead or recycled
pid cannot be mistaken for a live owner:

| Platform | Process-start source | Fallback |
| --- | --- | --- |
| Linux | `/proc/{pid}/stat` field 20 (clock ticks) | pid-only |
| macOS | `LC_ALL=C ps -p {pid} -o lstart=` | pid-only |
| Windows | PowerShell `Get-Process -Id {pid}` epoch seconds | pid-only |

A platform-specific read that fails or yields an unparseable value degrades to
a pid-only identity (empty `process_start`). Liveness then resolves as: a dead
pid is definitively not live; a live pid with a matching `process_start` is
live; a live pid whose current `process_start` differs (PID reuse) is not live;
a pid-only identity is treated as live while the pid exists, with degraded
PID-reuse protection surfaced as an observability warning. Liveness returns
`unknown` only when even the pid signal cannot be probed.

File locking is cross-platform. The atomic `O_EXCL` create is the portable
fallback used on every platform; on Linux, `flock` is used when available for
stronger guarantees and the `O_EXCL` fallback applies when it is not. An
unsupported runtime—one that cannot provide even pid-only liveness or the
atomic create—fails before reserving control or creating or mutating Graph
state. Pure descriptor validation and scheduler logic remain portable and
tested across platforms.

Reclaim policy is **lease-based and converged across the `flock` and flock-less
paths** (B7/B10). The mutation lock (`<state>.mutation.lock`) is an `O_EXCL`
atomic create whose owner JSON is `{ version: 1, pid, createdAt, expires_at,
nonce }`. `expires_at` is the **sole reclaim key**: the holder writes
`expires_at = now + LEASE_MS` at acquire, and a later acquirer reclaims only once
`now >= expires_at`. There is **no process-liveness probing** on the mutation
lock-no `process.kill(pid, 0)`, no `/proc/<pid>/stat` start comparison, no
EPERM/ESRCH classification, no PID-reuse reasoning. `pid` and `nonce` stay for
debug/ownership identity only (release verifies `pid + nonce + createdAt` so a
holder does not unlink a lock a live owner lawfully reclaimed after the holder's
own lease expired).

`LEASE_MS` is 300000 (5 minutes): generous enough that a single
acquire->mutate->release cycle (a graph mutation or an autopilot state write)
always completes within the lease, so **v1 needs no renewal mechanism**. If the
holder crashes or fails to release, a later acquirer reclaims via lease expiry
(bounded recovery-via-expiry). Long-held locks would need renewal; that is
explicitly out of scope for v1.

Both paths read the on-disk owner's `expires_at` and apply the same decision:
a valid unexpired lease is LIVE (do not steal; wait/fail closed); a valid
expired lease is RECLAIMED (`unlinkSync` + re-acquire); a readable but
unparseable/invalid owner (corrupt) is RECLAIMED (no valid lease is on record,
so the owner cannot be live); an I/O read failure `EACCES`/`EMFILE`/`EIO`/
`ENOMEM` (non-ENOENT) FAILS CLOSED forever (the owner MAY be alive and we
cannot read its lease-log `state_mutation_lock_unverifiable`, no auto-steal,
no bounded reclaim, operator attention); and `ENOENT` (lock vanished: race)
retries `linkSync`. The `flock` path performs this inside `LOCK_REMOVAL_SCRIPT`
(run under an exclusive `flock` guard so the reclaim read+unlink is atomic);
the flock-less `O_EXCL` path performs the identical decision inline via
`readLockOwner`.

This lease design eliminates the recurring liveness edge-case blockers the
red-team reviewer found, because none can arise when no process liveness is
probed: **B5** (jiffies vs ms-epoch mismatch misclassifying a live self-owner
as PID-reused) - `processStartIdentity` is no longer consulted by the lock;
**B6** (EPERM misclassified as dead, stealing a live other-uid owner's lock) -
`process.kill(pid, 0)` is no longer called by the lock; **B7/B10** (flock vs
flock-less liveness divergence) - both paths reclaim on the same `expires_at`;
**B8** (test-seam complexity around `/proc` jiffies) - the
`__testCurrentProcessStart` seam is removed and lease tests plant `expires_at`
(clock-based, platform-agnostic); **B9** (EACCES-on-unreadable stealing a live
lock) - an unreadable lock fails closed forever; only corrupt or expired leases
are reclaimed.

The distinct emergency-journal crash-recovery subsystem
(`recoverEmergencyStateFile` / `emergencyMutateStateFileIf`) retains its own
process-start identity check for authenticating a crashed transaction's owner;
it is intentionally separate from the lease-based mutation lock so the lock
blockers above cannot recur there.

## Claim lease and expiry contract

A claim is a durable lease on one activation/attempt. `issued_at`,
`expires_at`, `lease_duration_ms`, `renewal_count`, and `max_renewals` bound
it; renewals extend `expires_at` only while the claim is still live.

Expiry is a **soft recovery signal**, not a hard fulfillment barrier. The
`complete` and `fail` operations gate on `status === 'live'` and do not consult
`expires_at`: an expired-but-still-live claim may still be fulfilled by its
original worker if it completes before recovery takes over, and its result is
accepted. Expiry matters in three places, and only there:

- **Renewal rejects expired claims.** `renew` throws `lease_expired` once
  `now >= expires_at`; an expired lease cannot be extended.
- **Recovery requires expiry.** `recover-expired-claim` throws `lease_live` if
  the claim has not yet expired; recovery only takes over abandoned claims.
- **Recovery disposition depends on the effect policy.** A `side_effect_free`
  or `idempotent` expired claim is taken over (`expired_retryable`, a fresh
  replacement attempt/lease). A `reconcile` expired claim is fenced as
  `reconciling` with reason `expired_ambiguous` and must be resolved with
  evidence or a human decision before the graph continues.

For effectful work: `idempotent` claims carry a durable external idempotency
key and may be safely retried after an expired lease; `reconcile` claims treat
an expired lease as an ambiguous external effect and never silently retry; and
`side_effect_free` claims may be retried freely because they produce no
external effect. A stale lease, a mismatched revision/sequence, an exhausted
back-edge bound, or an undeclared route fails closed.

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
