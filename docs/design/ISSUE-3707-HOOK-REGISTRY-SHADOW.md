# Issue #3707: Hook registry and dispatcher shadow mode

Parent epic: #3698. Planning contract: `docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md` §6.3, §8 step 5, §9.

**Status:** implemented (shadow mode only, no behavior change)
**Rollback:** `OMC_HOOK_SHADOW` defaults off; removing the shadow observation call in `src/hooks/bridge.ts` (`processHook` wrapper) fully restores prior behavior.

## Scope

This issue ships exactly two things:

1. **A declarative hook registry** (`src/hooks/registry/registry.ts`) covering every installed hook entrypoint with contract fields: `event`, `order`, `timeoutMs`, `riskClass`, `failMode` — plus `matcher`, `entrypoint`, `args`, `async`. Risk classes are derived by convention from the entrypoint name.
2. **A shadow-mode dispatcher** (`src/hooks/registry/dispatcher.ts`, `shadow.ts`): parses each event once, selects only applicable entries in declared order, enforces per-hook timeouts, applies declared fail-modes, and produces shadow-vs-legacy comparison records — without changing any runtime decision.

Non-goals (owned by successors): dispatcher cutover by event family (#3708), gate rationalization (#3709), hook entrypoint/module reduction (epic targets are measured after cutover, not in shadow mode).

## Design

### Registry derivation

The installed registration (`hooks/hooks.json`) remains the runtime SSOT. `buildHookRegistry(hooksJson)` derives one declarative entry per installed command. Risk classes are assigned by convention: only `pre-tool-enforcer.mjs` (destructive-mutation) and `permission-handler.mjs` (security-boundary) fail closed; everything else is advisory and fails open (owner decision 6). No hand-maintained metadata table.

`validateRegistryAgainstHooksJson` is the drift guard: unknown lifecycle events, unparseable commands, or missing timeouts are reported.

### Dispatcher

`createHookDispatcher(registry, { handlers })`:

- Parses the event once; `selectApplicableEntries` filters by event + matcher (`*` always applies; `SessionStart` matches `source`; `PermissionRequest`/`PreToolUse`/`PostToolUse` match tool name) and sorts by declared `order`.
- Every handler await is bounded by its declared `timeoutMs` (no unbounded waits; timers are unref'd so short-lived hook processes are never held open).
- Error/timeout handling follows the declared `failMode`: advisory hooks fail open with a structured diagnostic record and later hooks continue; hard-risk hooks fail closed and stop the chain.
- Emits one structured `DispatchRecord` per hook: id, event, duration, status, error class, risk class, fail mode, applied decision source.
- Latency budget (plan §6.3) is tested: no-op events p95 ≤ 50 ms, ordinary advisory events p95 ≤ 200 ms.

Shadow mode only: dry-run handlers execute and produce records, but no output is ever merged into a runtime decision — behavior change is impossible by construction. Active-mode dispatch is #3708.

### Shadow comparison

`runShadowObservation(hookType, legacyOutput, legacyDurationMs)` is called from the `processHook` wrapper in `src/hooks/bridge.ts` after the legacy path completes, gated by `OMC_HOOK_SHADOW` (default off). It:

- derives the registry from the installed `hooks/hooks.json` (cached per process),
- runs the dispatcher in shadow mode for the same event,
- records a `ShadowComparisonRecord` with verdict `equivalent` | `divergent` | `deferred` | `unmapped`.

Decision equivalence for side-effecting handlers is **deferred by design**: shadow mode never re-executes them (that would double-apply state mutations), so records carry decision-shape digests (sha256 of `{continue, hasMessage, decisionKind}` — never content) for cutover-time comparison in #3708.

Observation is in-process only: a bounded ring buffer (most recent 500 records) retains records for inspection by tests/doctor without persisting to the filesystem. `summarizeShadowLog` provides doctor/trace-style counts; `clearShadowLog` empties the buffer.

Shadow observation is fully fail-open: any internal error produces an `unmapped` record (or is swallowed at the call site) and never changes the legacy output. A bridge-level test proves `processHook` output is identical with the flag on and off.

## Seams for prerequisite/successor issues

- **#3702 (inventory manifest) — merged.** The registry is derived from `hooks/hooks.json` and covered by the drift test; `inventory/inventory-graph.json` inventories `src/hooks/**`.
- **#3703 (workflow registry) — merged.** Risk classes, `FailMode`, and `failModeForRisk` are imported directly from `src/workflow/registry.ts`; no parallel taxonomy exists.
- **#3708 (cutover) — successor.** Consumes the registry entries and the shadow buffer's `deferred`/`divergent` verdicts as per-family cutover evidence.

## Tests and acceptance evidence

`src/hooks/registry/__tests__/` (33 tests):

- **Registration drift:** zero drift vs installed `hooks/hooks.json`; detects unknown events, unparseable commands, missing timeouts.
- **Contract fields:** every entry carries event/order/timeout/risk/fail-mode; only the two hard-risk entrypoints fail closed.
- **Event ordering:** applicable entries run in declared order; non-matching matchers excluded.
- **Timeout/error fail-open vs fail-closed:** advisory errors fail open with diagnostics and do not stop later hooks; hard-risk errors fail closed and halt the chain; per-hook timeouts enforced within budget.
- **In-process telemetry:** buffer bounded at 500 records; clear/summarize work correctly.
- **Shadow-vs-legacy decision equivalence:** verdict taxonomy, decision-shape digest privacy (content-independent), mapped/unmapped/divergent paths.
- **No behavior change:** `processHook` output identical with `OMC_HOOK_SHADOW` on/off; observation failures never block the legacy path.
- **Latency budget:** no-op p95 ≤ 50 ms; advisory p95 ≤ 200 ms.

## Rollback

1. `OMC_HOOK_SHADOW` is unset/off by default — shadow code is inert.
2. Remove the shadow observation call in `src/hooks/bridge.ts` (`processHook` wrapper) and optionally delete `src/hooks/registry/`. No other runtime surface references the registry.
