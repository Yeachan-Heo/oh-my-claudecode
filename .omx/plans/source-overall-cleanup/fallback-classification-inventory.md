# Fallback Classification Inventory — G001 Source-Overall Cleanup

Worker: worker-3
Task: G001 fallback classification inventory
Scope: readiness artifact only; no source edits; no `.omx/ultragoal` mutation.

## Inputs and method

Approved plan/context read from leader-owned artifacts because this worktree did not contain them initially:
- `.omx/plans/prd-source-overall-aggressive-cleanup.md`
- `.omx/plans/test-spec-source-overall-aggressive-cleanup.md`
- `.omx/context/source-overall-aggressive-cleanup-20260521T053809Z.md`

Inventory method:
- Searched likely Lane 2 fallback domains named by the PRD/context: `src/config/*`, `src/features/state-manager/*`, `src/features/delegation-routing/*`, `src/tools/python-repl/*`, `src/tools/diagnostics/*`, `src/tools/lsp/*`, `src/openclaw/*`, `src/features/rate-limit-wait/*`, `src/features/auto-update.ts`, and `src/tools/state-tools.ts`.
- Used keyword search for fallback-like constructs: `fallback`, `legacy`, `default`, `catch`, `silent`, `best-effort`, `non-blocking`, `unavailable`, `timeout`, `compat`.
- Classified only likely source targets for future cleanup lanes. Test anchors are included to show current behavior locks or missing lock candidates.

## Classification legend

- **Masking slop**: hides actionable failure, silently disables behavior, or makes broad alternate behavior hard to observe.
- **Grounded compatibility / fail-safe**: intentionally preserves runtime compatibility or safety at external boundaries, with bounded behavior and observable evidence.
- **Ambiguous escalation**: may be legitimate, but source contract and test expectations need leader/ralplan decision before deletion or preservation.

## High-priority inventory

| File / area | Current fallback-like behavior | Classification | Source anchors | Test anchors / lock status | Cleanup gate recommendation |
|---|---|---|---|---|---|
| `src/tools/diagnostics/index.ts` | `auto` chooses `tsc` when `tsconfig.json` exists, otherwise falls back to LSP aggregation; LSP formatting reports missing servers and skipped files instead of claiming success. | **Grounded compatibility / fail-safe** | `src/tools/diagnostics/index.ts:1-7`, `src/tools/diagnostics/index.ts:34-54`, `src/tools/diagnostics/index.ts:104-158` | `src/tools/diagnostics/__tests__/lsp-aggregator.test.ts` exists; LSP client tests under `src/tools/lsp/__tests__/`. | Preserve as a compatibility fallback. Future edits should add/verify a contract test that `auto` exposes incomplete LSP checks when servers are missing, not silently passing. |
| `src/tools/python-repl/paths.ts` | Runtime directory resolution validates `XDG_RUNTIME_DIR`, falls back to platform cache dirs, then `os.tmpdir()` for unsupported platforms. | **Grounded compatibility / fail-safe** | `src/tools/python-repl/paths.ts:45-63`, `src/tools/python-repl/paths.ts:65-105` | Python REPL tests exist under `src/tools/python-repl/__tests__/`, including sandbox and TCP fallback coverage. | Preserve, but future cleanup should make rejected XDG reasons observable in debug diagnostics if not already covered. |
| `src/tools/python-repl/socket-client.ts` | Supports TCP transport when socket path is `tcp:<port>`, validates port, and otherwise uses Unix socket path. JSON parse and protocol failures reject with explicit errors. | **Grounded compatibility / fail-safe** | `src/tools/python-repl/socket-client.ts:95-106`, `src/tools/python-repl/socket-client.ts:135-166` | `src/tools/python-repl/__tests__/tcp-fallback.test.ts` exists. | Preserve. Require primary Unix socket and TCP fallback tests before any transport cleanup. |
| `src/openclaw/dispatcher.ts` | OpenClaw gateway calls are explicitly non-blocking for hooks; URL validation rejects unsafe URLs; HTTP/command errors return structured `OpenClawResult` failures instead of throwing. | **Grounded compatibility / fail-safe** | `src/openclaw/dispatcher.ts:1-7`, `src/openclaw/dispatcher.ts:20-38`, `src/openclaw/dispatcher.ts:90-134`, `src/openclaw/dispatcher.ts:143-186` | `src/openclaw/__tests__/dispatcher.test.ts`, `src/hooks/__tests__/bridge-openclaw.test.ts`, `src/hooks/session-end/__tests__/openclaw-session-end.test.ts`. | Preserve the non-blocking contract. Cleanup can improve naming and observability, but must not make hook execution depend on gateway availability. |
| `src/openclaw/config.ts` | Disabled env flag, missing config, invalid config, disabled mappings, or malformed gateway entries all resolve to `null`. | **Ambiguous escalation** | `src/openclaw/config.ts:20-57`, `src/openclaw/config.ts:64-85` | `src/openclaw/__tests__/config.test.ts` exists. | Keep env-disabled/missing-config as grounded opt-in behavior. Consider converting invalid JSON/malformed enabled config into debug-visible evidence; do not delete without OpenClaw config contract review. |
| `src/features/rate-limit-wait/rate-limit-monitor.ts` | Usage API errors or missing credentials return `null`; status carries `apiErrorReason` and `usingStaleData` when stale rate-limit data is present. | **Grounded compatibility / fail-safe** | `src/features/rate-limit-wait/rate-limit-monitor.ts:14-25`, `src/features/rate-limit-wait/rate-limit-monitor.ts:33-82` | `src/__tests__/rate-limit-wait/rate-limit-monitor.test.ts`. | Preserve because rate-limit waiting must be non-fatal without OAuth. Future cleanup should assert stale-cache observability and `null` unavailable behavior. |
| `src/features/rate-limit-wait/pane-fresh-capture.ts` | Corrupt/missing pane tail state starts fresh; write failures are best-effort; dead panes/tmux failures return empty string to avoid stale re-alerts. | **Grounded compatibility / fail-safe** | `src/features/rate-limit-wait/pane-fresh-capture.ts:30-48`, `src/features/rate-limit-wait/pane-fresh-capture.ts:51-77`, `src/features/rate-limit-wait/pane-fresh-capture.ts:111-123` | `src/__tests__/rate-limit-wait/pane-fresh-capture.test.ts`. | Preserve stale-alert prevention. Future cleanup may add debug logging for state corruption/write failures, but should not re-emit stale pane content. |
| `src/features/rate-limit-wait/tmux-detector.ts` | Missing tmux, invalid panes, dead panes, or tmux command failures return empty/false and log some errors. | **Grounded compatibility / fail-safe** | `src/features/rate-limit-wait/tmux-detector.ts:109-119`, `src/features/rate-limit-wait/tmux-detector.ts:131-171`, `src/features/rate-limit-wait/tmux-detector.ts:174-201` | `src/__tests__/rate-limit-wait/tmux-detector.test.ts`, `src/openclaw/__tests__/dead-pane-guard.test.ts`. | Preserve as runtime boundary behavior. Cleanup should not throw from hook/daemon scan paths. |
| `src/features/rate-limit-wait/daemon.ts` | Log rotation and cleanup failures are ignored; poll-loop errors are counted and persisted; unavailable rate-limit status logs a message and continues. | **Ambiguous escalation** | `src/features/rate-limit-wait/daemon.ts:121-153`, `src/features/rate-limit-wait/daemon.ts:350-445`, `src/features/rate-limit-wait/daemon.ts:524-530` | `src/__tests__/rate-limit-wait/daemon.test.ts`, `src/__tests__/rate-limit-wait/daemon-bootstrap.test.ts`, `src/__tests__/rate-limit-wait/integration.test.ts`. | Preserve poll-loop resilience. Consider making ignored log-rotation/cleanup failures visible in verbose mode; classify exact cleanup branches before source edits. |
| `src/features/auto-update.ts` config reader | Missing or invalid config disables silent auto-update by default. | **Grounded compatibility / fail-safe** | `src/features/auto-update.ts:420-447` | `src/__tests__/auto-update.test.ts` exists. | Preserve security default. Do not convert missing/invalid config into auto-enable behavior. |
| `src/features/auto-update.ts` background update check | Background update check suppresses failures unless `OMC_DEBUG` is set. | **Ambiguous escalation** | `src/features/auto-update.ts:1063-1087` | `src/__tests__/auto-update.test.ts` exists. | Likely preserve non-blocking startup semantics, but require a test or debug evidence assertion before cleanup. Could route failures to a debug/event log rather than only stderr under `OMC_DEBUG`. |
| `src/features/auto-update.ts` silent update state/logging | Corrupt silent-update state resets failure counters; log write failures are silently ignored; silent update errors are logged and returned as unsuccessful result. | **Ambiguous escalation** | `src/features/auto-update.ts:1149-1160`, `src/features/auto-update.ts:1174-1190`, `src/features/auto-update.ts:1210-1295` | `src/__tests__/auto-update.test.ts` exists. | Preserve opt-in and backoff. Escalate corrupt state reset because it can mask repeated update failures; consider quarantining corrupt state or surfacing a warning in the silent log. |
| `src/features/state-manager/index.ts` | Standard state read failure warns then tries legacy locations; legacy read failure warns then proceeds; final result may be `exists:false`. | **Ambiguous escalation** | `src/features/state-manager/index.ts:120-227` | `src/features/state-manager/__tests__/cache.test.ts` covers cache behavior, but legacy failure behavior may need focused tests. | Preserve legacy migration path. Before cleanup, add tests distinguishing corrupt standard state vs missing state, and decide whether corrupt standard state should block fallback to legacy. |
| `src/tools/state-tools.ts` legacy/session state cleanup | Clears working-directory local, legacy, owner-owned, and session-scoped state candidates; unlink/parse failures become `hadFailure`, but cancel-signal writes are best-effort. | **Ambiguous escalation** | `src/tools/state-tools.ts:190-285`, `src/tools/state-tools.ts:747-1133`, `src/tools/state-tools.ts:1018-1031` | `src/tools/__tests__/state-tools.test.ts`. | Serialized owner: Lane 2 first. Do not seam-extract until fallback/state-contract handoff is complete. Add tests for `hadFailure` propagation and cancel-signal best-effort observability before changes. |
| `src/features/delegation-routing/resolver.ts` | Deprecated `codex`/`gemini` providers warn and fall back to Claude Task; invalid fallback-chain entries are skipped. | **Grounded compatibility / fail-safe** for deprecated provider fallback; **ambiguous** for invalid fallback-chain skipping. | `src/features/delegation-routing/resolver.ts:20-48`, `src/features/delegation-routing/resolver.ts:77-88`, `src/features/delegation-routing/resolver.ts:128-141`, `src/features/delegation-routing/resolver.ts:144-171` | `src/features/delegation-routing/__tests__/resolver.test.ts:16-33`, `src/features/delegation-routing/__tests__/resolver.test.ts:103-140`, `src/features/delegation-routing/__tests__/resolver.test.ts:305-343`. | Preserve deprecated-provider fallback for compatibility. Escalate malformed fallback-chain handling if the cleanup wants stricter config validation. |
| `src/config/models.ts` and `src/config/loader.ts` model defaults | Tier model resolution falls through env precedence to built-in defaults; external model fallback policy defaults to `provider_chain` while cross-provider fallback is disabled. | **Grounded compatibility / fail-safe** with public-config implications | `src/config/models.ts:73-180`, `src/config/loader.ts:31-42`, `src/config/loader.ts:143-155` | `src/config/__tests__/models.test.ts:262-282`, `src/config/__tests__/loader.test.ts:77-118`, `src/config/__tests__/loader.test.ts:368-373`. | Preserve unless public model-routing contract changes. Any stricter behavior needs config migration notes and tests because env precedence is heavily covered. |

## Masking-slop candidates to prioritize first

These are the most likely first cleanup targets because they hide evidence more than they preserve compatibility:

1. **Silent update corrupt state reset** — `src/features/auto-update.ts:1149-1160` resets to clean state on parse failure. This may erase `consecutiveFailures` evidence. Add a regression test that corrupt state is quarantined or reported before changing behavior.
2. **Silent log write failures** — `src/features/auto-update.ts:1174-1190` ignores failures. Because this is optional logging, throwing would be wrong, but debug-visible evidence should be considered.
3. **State-tool cancel-signal best-effort writes** — `src/tools/state-tools.ts:1018-1031` suppresses write failures on cancellation signals. This may hide Stop-hook coordination failures. Add tests around visible warning/result content before changing.
4. **State-manager corrupt standard state fallback** — `src/features/state-manager/index.ts:189-227` warns and may continue to legacy state. If standard state exists but is corrupt, falling back to legacy can mask data loss. Needs source-contract decision.
5. **OpenClaw invalid enabled config returns null** — `src/openclaw/config.ts:45-57` treats invalid enabled config the same as disabled/missing config. Consider debug-visible evidence while preserving opt-in no-op semantics.

## Grounded fallbacks to protect from deletion

Do not delete these under an anti-slop pass without replacing their contracts:

- Diagnostics `tsc` → LSP fallback and missing-language-server reporting (`src/tools/diagnostics/index.ts:1-7`, `src/tools/diagnostics/index.ts:34-54`, `src/tools/diagnostics/index.ts:104-158`).
- Python REPL secure runtime-dir fallback and TCP socket fallback (`src/tools/python-repl/paths.ts:45-105`, `src/tools/python-repl/socket-client.ts:95-106`).
- OpenClaw non-blocking gateway dispatch (`src/openclaw/dispatcher.ts:1-7`, `src/openclaw/dispatcher.ts:90-134`, `src/openclaw/dispatcher.ts:143-186`).
- Rate-limit wait unavailable API/tmux/dead-pane behavior (`src/features/rate-limit-wait/rate-limit-monitor.ts:19-82`, `src/features/rate-limit-wait/tmux-detector.ts:109-201`, `src/features/rate-limit-wait/pane-fresh-capture.ts:111-123`).
- Config/model env precedence and built-in default model fallbacks (`src/config/models.ts:73-180`, `src/config/loader.ts:31-42`).

## Required test-locks before Lane 2 edits

1. `src/__tests__/auto-update.test.ts`: add/confirm tests for corrupt silent-update state, silent log write failure behavior, and non-blocking `backgroundUpdateCheck` debug path before modifying `src/features/auto-update.ts`.
2. `src/features/state-manager/__tests__/cache.test.ts` or new state-manager test: lock corrupt standard state vs legacy fallback behavior before modifying `src/features/state-manager/index.ts`.
3. `src/tools/__tests__/state-tools.test.ts`: lock `hadFailure` propagation and cancel-signal write failure evidence before modifying `src/tools/state-tools.ts`.
4. `src/openclaw/__tests__/config.test.ts`: lock invalid enabled config behavior before changing `src/openclaw/config.ts`.
5. Existing preservation tests should be re-run for grounded fallbacks before and after edits:
   - `src/tools/python-repl/__tests__/tcp-fallback.test.ts`
   - `src/tools/diagnostics/__tests__/lsp-aggregator.test.ts`
   - `src/openclaw/__tests__/dispatcher.test.ts`
   - `src/__tests__/rate-limit-wait/*.test.ts`
   - `src/features/delegation-routing/__tests__/resolver.test.ts`
   - `src/config/__tests__/models.test.ts` and `src/config/__tests__/loader.test.ts`

## Lane ownership / handoff notes

- `src/tools/state-tools.ts` remains a Lane 2 fallback/state-contract file until this inventory is accepted and a follow-up handoff explicitly allows Lane 3 seam extraction.
- No source file should be edited from this inventory alone; each ambiguous item requires a focused behavior lock and a leader/ralplan decision.
- Public surface risk exists for config/model routing, delegation routing, state-file layout, hook/OpenClaw behavior, diagnostics output, and rate-limit daemon status. Any incompatible change needs migration/release notes per PRD.
