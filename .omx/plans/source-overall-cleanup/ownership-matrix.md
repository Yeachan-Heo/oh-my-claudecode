# Source-Overall Aggressive Cleanup — Exclusive Ownership Matrix

Source of truth:
- PRD: `.omx/plans/prd-source-overall-aggressive-cleanup.md`
- Test spec: `.omx/plans/test-spec-source-overall-aggressive-cleanup.md`
- Context snapshot: `.omx/context/source-overall-aggressive-cleanup-20260521T053809Z.md`

## Rules
- One active owner per file or serialized module family.
- No parallel edits to `src/tools/state-tools.ts`; it starts in Lane 2 and can move to Lane 3 only via explicit handoff.
- Test files may be owned independently from source files.
- Generated artifacts are not source-lane targets; they are verified at the end of the workflow.

## Lane 0 — Baseline / inventory lock
Owner: planner/verifier only; no source edits.

| Target | Purpose |
| --- | --- |
| `.omx/plans/source-overall-cleanup/*` | Readiness artifacts only |
| `git status`, `npm test -- --run`, `npm run build`, `npm run lint` | Baseline verification |
| Fallback inventory | Classify masking vs grounded compatibility |

## Lane 1 — Test contract hardening
Owner: `test-engineer` / `executor` on tests only.

| File(s) | Purpose |
| --- | --- |
| `src/config/__tests__/loader.test.ts` | Config loading and routing contract lock |
| `src/config/__tests__/models.test.ts` | Provider/model inference contracts |
| `src/__tests__/state-root-resolution.test.ts` | Centralized state-root regression lock |
| `src/__tests__/hooks.test.ts` | Hook bridge / persistent mode behavior lock |
| `src/hooks/__tests__/bridge-routing.test.ts` | Hook routing matrix and prereq gating |
| `src/tools/python-repl/__tests__/python-sandbox.test.ts` | Sandbox execution boundary lock |
| `src/tools/python-repl/__tests__/tcp-fallback.test.ts` | Unix socket / TCP fallback lock |
| `src/team/__tests__/runtime-cli.test.ts` | Runtime CLI artifacts and terminal preservation |
| `src/team/__tests__/teardown-invariant.test.ts` | Drain/stop teardown contract |

## Lane 2 — Fallback / state-contract cleanup
Owner: one executor lane; serialized targets only.

| File family | Notes |
| --- | --- |
| `src/tools/state-tools.ts` | First probe target; serialized classification before any seam extraction |
| `src/config/loader.ts`, `src/config/models.ts` | Config/model fallback and inheritance rules |
| `src/features/state-manager/*` | State-path / persistence behavior |
| `src/tools/python-repl/*` | Grounded compatibility fallback at runtime boundary |
| `src/tools/diagnostics/*`, `src/tools/lsp/*` | Toolchain fallback boundary; classify before deletion |
| `src/features/delegation-routing/*` | Routing defaults / inheritance fallbacks |
| `src/features/rate-limit-wait/*` | Runtime smoke/fallback behavior around tmux / capture |
| `src/features/auto-update.ts` | Update-path compatibility and stale-root handling |
| `src/openclaw/*` | External gateway compatibility behavior |

## Lane 3 — Orchestrator seam extraction
Owner: one executor lane; no overlap with Lane 2 serialized files.

| File family | Notes |
| --- | --- |
| `src/hooks/bridge.ts` | Hook dispatch / normalization / state IO seams |
| `src/hooks/persistent-mode/index.ts` | Unified stop handler seams |
| `src/team/runtime-v2.ts` | Team convergence and teardown seams |
| `src/installer/index.ts` | Installer orchestration seams |
| `src/cli/index.ts` | CLI parsing / command registration seams |
| `src/cli/team.ts` | Team CLI surface seams |
| `src/hooks/subagent-tracker/index.ts` | Subagent tracking / cleanup seams |

## Lane 4 — Duplication / boundary cleanup
Owner: only after owning lane completes its previous target family.

| File family | Notes |
| --- | --- |
| Shared helper modules touched by earlier lanes | Consolidate duplicated path / rendering / state helpers |
| Wrong-layer imports or hidden side effects | Remove only after test lock is in place |

## Lane 5 — Dead code / warning cleanup
Owner: final pass only.

| File family | Notes |
| --- | --- |
| Touched files with unused imports / variables | Clean only after functional tests pass |
| Test-only slop (`as any`, eslint disables) | Remove only if coverage remains equivalent or better |

## Hand-off rule
- A file moves to the next lane only after the previous lane has a completed artifact or explicit handoff note.
- `src/tools/state-tools.ts` is the only explicitly serialized file-family in the PRD; all later work on it must wait for Lane 2 completion.
