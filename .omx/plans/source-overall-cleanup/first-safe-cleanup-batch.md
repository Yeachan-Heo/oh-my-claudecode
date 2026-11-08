# First Safe Cleanup Batch: Behavior-Locked Fallback Resolution

## Scope and stop rule

This is a **planning/readiness artifact only** for Ultragoal `G001-lane0-lane1-execution-readiness`. It does not authorize this worker to edit source. The first implementation batch should touch only the files listed below after the owner has re-run the named tests and added the missing behavior locks. Do not mutate `.omx/ultragoal`.

Stop the batch before source edits if any listed target is already owned by another lane, if a public CLI/API/MCP/hook contract would change without explicit release notes, or if a fallback cannot be classified as either grounded compatibility/fail-safe or masking slop.

## Batch objective

Turn fallback-heavy but already well-covered code into a locked, reviewable first cleanup slice. The batch deliberately avoids the largest orchestrators (`src/hooks/bridge.ts`, `src/team/runtime-v2.ts`, `src/cli/index.ts`, `src/installer/index.ts`) and starts with smaller, contract-shaped modules that already have focused tests.

## Target file ownership for this batch

| Owner lane | Source file | Existing test anchors | Allowed cleanup class | Notes |
| --- | --- | --- | --- | --- |
| Lane 2 fallback/state-contract owner | `src/features/state-manager/index.ts` | `src/features/state-manager/__tests__/cache.test.ts` | State fallback classification, pure-read/write-lock cleanup, helper extraction within same module | Existing file is 818 LOC and already documents standard local/global state plus legacy fallback at lines 4-12. Read/cache logic at lines 126-220 is behavior-sensitive; do not combine with seam extraction in Lane 3 until this fallback pass is done. |
| Lane 2 model/config owner | `src/config/models.ts` | `src/config/__tests__/models.test.ts` | Explicit provider/model fallback semantics; env-priority cleanup | Existing tests cover Bedrock/Vertex/provider inheritance, direct session model precedence, tier defaults, and subagent-safe IDs. Preserve public env behavior unless a stricter source contract is explicitly approved. |
| Lane 2 delegation-routing owner | `src/features/delegation-routing/resolver.ts` | `src/features/delegation-routing/__tests__/resolver.test.ts` | Deprecated provider fallback classification and naming cleanup | Tests already cover deprecated `gemini`/`codex` fallback-to-claude and fallback-chain parsing; this is a good first place to replace ambiguous fallback wording with explicit compatibility semantics. |
| Compatibility fallback owner | `src/tools/python-repl/socket-client.ts` | `src/tools/python-repl/__tests__/tcp-fallback.test.ts` | Preserve grounded TCP/socket fallback; add negative/error observability if missing | PRD names Python REPL path/socket runtime fallback as likely grounded. Do not delete this fallback; document and test both `tcp:<port>` and path socket behavior. |
| Compatibility fallback owner | `src/openclaw/dispatcher.ts` | `src/openclaw/__tests__/dispatcher.test.ts` | Preserve non-blocking hook gateway behavior; clarify error result contract | PRD names OpenClaw non-blocking gateway behavior as likely grounded. Existing tests cover URL validation, timeout/network errors, shell escaping, command gateway env, and non-Error thrown values. |
| Diagnostics fallback owner | `src/tools/diagnostics/lsp-aggregator.ts` | `src/tools/diagnostics/__tests__/lsp-aggregator.test.ts` | Preserve tsc-to-LSP style fallback/diagnostic observability | PRD names diagnostics tsc→LSP fallback as likely grounded. Existing tests cover missing language-server hints, unregistered file pre-checks, and byte-identical happy-path formatting. |

## Existing behavior locks to run before editing

Run these commands before the first source change in this batch:

```bash
npm test -- --run src/features/state-manager/__tests__/cache.test.ts
npm test -- --run src/config/__tests__/models.test.ts
npm test -- --run src/features/delegation-routing/__tests__/resolver.test.ts
npm test -- --run src/tools/python-repl/__tests__/tcp-fallback.test.ts
npm test -- --run src/openclaw/__tests__/dispatcher.test.ts
npm test -- --run src/tools/diagnostics/__tests__/lsp-aggregator.test.ts
```

If test runtime is a concern, execute them as one Vitest invocation:

```bash
npm test -- --run \
  src/features/state-manager/__tests__/cache.test.ts \
  src/config/__tests__/models.test.ts \
  src/features/delegation-routing/__tests__/resolver.test.ts \
  src/tools/python-repl/__tests__/tcp-fallback.test.ts \
  src/openclaw/__tests__/dispatcher.test.ts \
  src/tools/diagnostics/__tests__/lsp-aggregator.test.ts
```

## Tests to add before cleanup edits

Add missing tests first, then refactor/delete. Minimum additions:

1. `src/features/state-manager/__tests__/cache.test.ts`
   - Add a malformed standard-state JSON test that asserts the current contract explicitly: warning is observable and the result falls through to legacy only when `checkLegacy` is enabled.
   - Add a missing-standard/malformed-legacy test that asserts `exists:false` plus warning evidence rather than silent masking.
2. `src/config/__tests__/models.test.ts`
   - Add a precedence-table test for direct Claude session env vs stale non-Claude tier defaults. Existing anchors around `isNonClaudeProvider()` and `resolveInheritedModelFromEnv()` already cover many cases; the new test should lock the exact env priority table before simplifying conditionals.
3. `src/features/delegation-routing/__tests__/resolver.test.ts`
   - Add a test naming the deprecated-provider compatibility contract: deprecated `gemini`/`codex` routes normalize to `claude`, and the result must expose enough fallback-chain evidence for callers to know compatibility was applied.
4. `src/tools/python-repl/__tests__/tcp-fallback.test.ts`
   - Add a bad `tcp:` value test (`tcp:not-a-port`, `tcp:0`, or equivalent current parser boundary) that fails with explicit connection/config evidence, not a misleading socket-path fallback.
5. `src/openclaw/__tests__/dispatcher.test.ts`
   - Add a timeout-result shape test that asserts gateway name, `success:false`, and non-empty error text so the non-blocking hook behavior remains observable.
6. `src/tools/diagnostics/__tests__/lsp-aggregator.test.ts`
   - Add/retain a missing-language-server result test before changing aggregator fallback control flow; install hints must remain visible.

## Source-contract change rules

Allowed without release notes:

- Renaming local helpers, extracting private helpers within the same module, removing duplicated branches, and replacing broad comments like “fallback” with precise contract names when exported behavior is unchanged.
- Making error evidence more explicit in returned objects or warnings when existing tests only asserted `success:false`/`exists:false` and no public text contract is documented.
- Removing unreachable compatibility branches only after a test proves the branch is unreachable under supported inputs.

Requires leader/plan escalation before edit:

- Changing package exports, `bin` behavior, hook event semantics, MCP tool output schema, team runtime status shape, CLI exit codes/text, state file layout, or generated artifact policy.
- Deleting Python REPL TCP/socket fallback, OpenClaw non-blocking failure behavior, or diagnostics install-hint fallback. These are classified as likely grounded compatibility/fail-safe fallbacks by the approved PRD.
- Editing `src/tools/state-tools.ts`; PRD serializes it under Lane 2 first, and later seam extraction requires an explicit handoff.

## Recommended first implementation order

1. **State-manager lock:** add the malformed JSON / legacy fallthrough tests in `cache.test.ts`; then simplify only private read-path fallback code in `state-manager/index.ts` if tests stay green.
2. **Delegation/config lock:** add env/provider precedence tests in `models.test.ts` and deprecated-provider observability tests in `resolver.test.ts`; then normalize naming/branching without changing public routing behavior.
3. **Compatibility preservation lock:** add negative-boundary tests for Python REPL TCP parsing, OpenClaw timeout/error result shape, and diagnostics install hints; then only clarify code paths, not behavior.

Do not run these three implementation groups in parallel if they need a shared helper. As written, their source ownership is disjoint and can be parallelized after tests are added.

## Verification commands after edits

After any source change in this batch, run:

```bash
npm test -- --run \
  src/features/state-manager/__tests__/cache.test.ts \
  src/config/__tests__/models.test.ts \
  src/features/delegation-routing/__tests__/resolver.test.ts \
  src/tools/python-repl/__tests__/tcp-fallback.test.ts \
  src/openclaw/__tests__/dispatcher.test.ts \
  src/tools/diagnostics/__tests__/lsp-aggregator.test.ts
npm run build
npm run lint
npm audit --omit=dev
```

Final cleanup PR verification still requires the approved full gates: `npm test -- --run`, `npm run build`, `npm run lint`, and the recorded generated-artifact policy decision for `dist/`, `bridge/*.cjs`, `bridge/team.js`, composed docs/shared outputs, runtime CLI, team server, and MCP bridge outputs.

## Concrete source/test anchors used

- Approved PRD: `.omx/plans/prd-source-overall-aggressive-cleanup.md` — Lane 2 fallback-like code gate, public surface gate, and known grounded fallback domains.
- Approved test spec: `.omx/plans/test-spec-source-overall-aggressive-cleanup.md` — fallback deletion/retention test requirements and static/security default of `npm audit --omit=dev`.
- Context snapshot: `.omx/context/source-overall-aggressive-cleanup-20260521T053809Z.md` — initial fallback grep domains and pre-existing `.github/workflows/release.yml` exclusion.
- `src/features/state-manager/index.ts:4-12`, `src/features/state-manager/index.ts:126-220` — state location/fallback contract and read-path fallback/cache logic.
- `src/features/state-manager/__tests__/cache.test.ts:37-147`, `src/features/state-manager/__tests__/cache.test.ts:225-451` — cache immutability, pure read, invalidation, TOCTOU, update atomicity, and stale-state behavior locks.
- `src/config/__tests__/models.test.ts:41-282`, `src/config/__tests__/models.test.ts:290-436` — provider detection, inheritance, family resolution, suffix, and subagent-safe model locks.
- `src/features/delegation-routing/__tests__/resolver.test.ts:5-304`, `src/features/delegation-routing/__tests__/resolver.test.ts:304-379` — route resolution and fallback-chain parser locks.
- `src/tools/python-repl/__tests__/tcp-fallback.test.ts:14-132`, `src/tools/python-repl/__tests__/tcp-fallback.test.ts:139-181` — TCP bridge and socket-path fallback locks.
- `src/openclaw/dispatcher.ts:1-7`, `src/openclaw/dispatcher.ts:90-135`, `src/openclaw/dispatcher.ts:143-187` — non-blocking gateway result contracts.
- `src/openclaw/__tests__/dispatcher.test.ts:94-264`, `src/openclaw/__tests__/dispatcher.test.ts:331-474` — HTTP/timeout/network/command gateway behavior locks.
- `src/tools/diagnostics/__tests__/lsp-aggregator.test.ts:26-95` — diagnostics fallback/install-hint and formatting locks.
