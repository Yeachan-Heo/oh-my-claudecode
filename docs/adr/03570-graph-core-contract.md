# ADR 03570: Graph Core Contract (Descriptor + Pure Scheduler)

- **Status:** Accepted for v1 — this landing
- **Issue:** #3570 (non-closing `Refs #3570`; issue remains open for the broader disposition sequence)
- **Decision scope:** A standalone pure `src/graph/` module: deeply readonly descriptor contract, strict bounded Zod schemas, local canonical compact JSON with SHA-256 sealing, and a deterministic pure scheduler. No runtime, persistence, OCC, CLI, HUD, installer, hooks, templates, or generated `dist`/`bridge` surfaces.

## Decision

Land Graph Core v1 as a nine-file source-only slice — descriptor foundation plus a pure scheduler — derived for current `dev` (oracle `99ffe31` used only for behavioral cross-checks, never as import authority). The module owns:

- **Descriptor contract:** deeply readonly TypeScript types, strict `.strict()` Zod content schemas, defensive `structuredClone` + `deepFreeze` ownership, structure-before-hash validation, and lowercase SHA-256 over a local canonical compact JSON. Canonicalization recursively sorts keys, preserves array order, accepts only JSON primitives, arrays, and plain objects, and rejects `undefined`, non-finite numbers, unsupported values, non-plain objects, and cycles.
- **Hash contract:** `descriptor_hash` is a 64-hex lowercase SHA-256 over exactly the nine contract fields (`descriptor_version`, `run_id`, `revision_id`, `goal`, `nodes`, `edges`, `entry_node_ids`, `concurrency_limit`, `terminal_verification_node_id`); `descriptor_hash` and all mutable/runtime fields are excluded. Structure is validated before any hash comparison.
- **Node/edge semantics:** agent/command executable nodes with descriptor-derived budgets; human-approval nodes with exactly one fixed outgoing edge; joins with exactly one fixed outgoing edge; fixed edges are exclusive; conditional/back-edge routes are declared; fan-out requires ≥2 fan_out edges with a single owning join; back edges are bounded structural returns; non-back-edge forward cycles are rejected; fork/join regions are non-overlapping, non-nesting, and forbid region-crossing edges; entry nodes may not be joins or interior fork-branch nodes.
- **Pure scheduler contract:** every entrypoint consumes a `SealedGraphDescriptor`; the projection is bound to `descriptor_hash`/`run_id`/`revision_id`; all mutations and the four descriptor-dependent reads throw `descriptor_mismatch` on hash drift; ready lists are ordered by a locale-independent code-unit comparator; identities live in one global namespace per projection with context-aware key validation; the three record-bearing mutations (`applyNodeResult`, `applyHumanApproval`, `resolveJoin`) are replay-fenced with versioned fingerprints (`fingerprint_version: 1`) bound to `descriptor_hash`; `beginActivationAttempt`/`releaseAttemptForRetry` are plain projection transforms that commit no transition records; retry budgets are descriptor-derived and unbypassable; final-budget release terminal-fails (never an unstartable ready activation); human approval is a dedicated pure transition whose `approved`/`denied` records carry `output_summary` (never `summary`) and no `attempt_id`; terminal success requires evidence.

### Ownership flow (stage-04)

| API                          | Input class                  | Returns                      | Behavior                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseGraphDescriptor`       | Hashless/draft shape         | `GraphDescriptor` (unsealed) | Strict schema parse → full `validateGraphDescriptor` → defensive `structuredClone` + `deepFreeze`. Input carrying a `descriptor_hash` throws a directed error (`parseSealedGraphDescriptor`).                                                                     |
| `sealGraphDescriptor`        | Hashless/draft shape         | `SealedGraphDescriptor`      | Strict parse → validate → compute hash → clone + freeze with `descriptor_hash`. Input carrying a `descriptor_hash` throws a directed error. Sole draft → scheduler producer.                                                                                      |
| `parseSealedGraphDescriptor` | Persisted hash-bearing shape | `SealedGraphDescriptor`      | Requires `descriptor_hash` (`/^[a-f0-9]{64}$/`; missing/malformed → `GraphDescriptorValidationError`); strict parse → validate → recompute hash and compare → mismatch rejects (never silently recomputes) → clone + freeze. Sole persisted → scheduler producer. |
| `verifyDescriptorHash`       | Any                          | `boolean`                    | Non-branding, never throws; structure-before-hash predicate; `false` on any structural failure or mismatch; does not clone/freeze/mutate its input.                                                                                                               |

Scheduler-accepted type is `SealedGraphDescriptor`; its producers are exactly `sealGraphDescriptor` (draft) and `parseSealedGraphDescriptor` (persisted). No assertion is needed anywhere: the type system makes it impossible to pass an unsealed value to a scheduler entrypoint.

### Approval transition records (stage-04)

`GraphCommittedTransition` is a discriminated union on `outcome`. Approval nodes never begin attempts, so `approved`/`denied` records omit `attempt_id` entirely; `attempt_id` appears only on `succeeded`/`failed` records. The summary field is unified to `output_summary` across `GraphApprovalDecision`, `graphApprovalDecisionSchema`, and the transition record (`summary` is removed from the public contract). Both approval outcomes require at least one evidence reference. `join_resolved` records carry a required `cohort_id` and no `attempt_id`.

### Closed error boundary

`GraphSchedulerErrorCode` is a closed union. Every scheduler throw uses exactly one code. Zod parse failures inside scheduler entrypoints are wrapped into `GraphSchedulerError('invalid_input', …)`; `ZodError` never escapes a scheduler entrypoint. Exported schema parsers keep throwing `ZodError` by documented validation-utility contract.

## Drivers

1. **Boundary purity** — no I/O, time reads, random allocation, process inspection, or mutation outside returned values (including on thrown paths).
2. **Re-derive, never port** — `99ffe31` is an oracle for invariants/regressions only; the contract is authored from the spec and this plan, verified by the anti-port matrix.
3. **Contract first, runnable never** — descriptor + pure scheduler semantics only; no runnable workflow is promised.
4. **Ownership and verifiability by construction** — readonly types, clone + freeze, structure-before-hash, descriptor-bound APIs, closed errors, unbypassable invariants.
5. **Evidence-backed governance** — every claim maps to a command; terminal PR verdict is APPROVE or BLOCK, derived fail-closed from final evidence.

## Alternatives

- **Port a minimal runtime vertical slice (store/claims/command service):** rejected — the locked Round-1 decision lands the pure contract first; the reference runtime depends on OCC APIs, mode-state I/O, session paths, and claims/revisions/store absent from current `dev`.
- **Import `canonicalizeJson` from `src/hooks/autopilot/pipeline.ts`:** rejected — ESM import would pull the stateful autopilot module graph into the pure module; current `dev` already treats the 20-line helper as copyable (private copies exist elsewhere).
- **Extract a shared `src/utils/canonical-json.ts` and refactor `pipeline.ts`:** rejected for this PR — modifies a shipped #3487 surface and widens the diff; a follow-up PR can own it.
- **Land one of the live #3570 disposition paths (bridge-only generated closure, six-file tip, full 91-file stack):** rejected — bridge-only requires owner-authorized regeneration of a generated surface; the six-file tip is insufficient for the descriptor + scheduler contract; the full stack violates the first-landing boundary.

## Why chosen

The pure core is the narrowest boundary that is both meaningful and mechanically verifiable: it resolves descriptor ownership, hashing, topology, attempt, route, join, approval, replay, and error contracts before any later runtime persists them, and it can be reviewed, typechecked, tested, and diff-audited independently on current `dev`.

## Consequences

- This PR does not create a runnable Graph workflow.
- Later runtime work must consume the sealed descriptor and scheduler contracts rather than redefine them.
- Runtime persistence, claims/revisions, OCC, control ownership, platform/recovery, CLI/skill/HUD/installer/hooks/templates, concurrency enforcement, and generated `dist`/`bridge` closure remain explicit later landings.
- `src/index.ts` is untouched; the module is exported only through `src/graph/index.ts`.

### Graph Core boundary

Nine files: `src/graph/types.ts`, `src/graph/schema.ts`, `src/graph/descriptor.ts`, `src/graph/scheduler.ts`, `src/graph/index.ts`, `src/graph/__tests__/fixtures.ts`, `src/graph/__tests__/descriptor.test.ts`, `src/graph/__tests__/scheduler.test.ts`, and this ADR. No other source path changes.

### Anti-port matrix (summary)

Adopted as invariants (re-derived from contract, cross-checked against the oracle): back-edge-only node rejection; per-lineage traversal bounds; route fencing (fail-closed `undeclared_route`); join consumed exactly once with branch-token arrival/consumption; terminal evidence required; A3 retryable-until-exhausted then terminal-failed; fingerprint-based replay. Not adopted, with replacement: caller-supplied `max_attempts` → descriptor-derived budget; per-kind identity uniqueness → single global identity namespace; `localeCompare` ordering → code-unit comparator; shallow top-level seal spread → deep clone + deep freeze; hash check without structure → structure-before-hash; open `code: string` errors → closed union; human-approval as executable → dedicated `applyHumanApproval`; begin/release without transition IDs → replay-fenced record-bearing mutations only; unbound projection → descriptor-bound projection + `descriptor_mismatch`; unversioned fingerprints → `fingerprint_version: 1` + `descriptor_hash` binding; undefined-filtering canonical JSON → strict current-dev semantics (throws); entries may include joins/branch interiors → eligible-entry rule; stage-03 `parseGraphDescriptor → GraphDescriptor` as a claimed sealed producer → disjoint producers (stage-04); stage-03 approval records requiring `attempt_id` + `summary` → no `attempt_id`, unified `output_summary`, discriminated union (stage-04).

### `concurrency_limit` semantics

`concurrency_limit` is sealed and validated by Graph Core (1–64 integer). Its enforcement is explicitly owned by the deferred claims/runtime layer; Graph Core performs no concurrency enforcement.

### Purity and imports

Module imports are limited to `node:crypto`, `zod`, and local modules. The scheduler clones its projection structurally before any mutation and never mutates its inputs, including on thrown paths. `traversalCounterKey(activation, edge)` is a pure key helper over `canonicalJson([activation.traversal_owner_id, edge.id])`.

## Governance

Execution proceeds only after explicit approval; this PR targets `dev` from a freshly fetched, pinned `origin/dev`, references #3570 without closing it, and records exact command statuses. The terminal PR verdict is evidence-driven `APPROVE` or `BLOCK` (never pre-assumed), ending with the exact footer:

```text
—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
```

## Follow-ups and explicit deferrals

Runtime persistence/state store; claims/leases/revisions; OCC journal/commit; control ownership; platform; settle-session; patch cycles; runtime graph-status promotion; `concurrency_limit` enforcement (claims/runtime layer); human-approval runtime UX/leases; CLI/skill/HUD/installer/plugin-manifest/hook/state-tool/template exposure; `dist`/`bridge` regeneration; full-runtime ADR; shared canonical-json util; `docs/REFERENCE.md`/`FEATURES.md` integration. Intended next order: runtime state/revision/claim contracts → OCC journal + state store → platform/control ownership → runtime operations/recovery → CLI/skill/HUD/installer → bounded generated delivery closure.
