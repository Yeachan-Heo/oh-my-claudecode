# User Testing Knowledge

## Testing Surface

- Project type: CLI/library repository (no web UI surface for this milestone).
- Milestone `data-integrity` assertions are validated through `vitest` and targeted code inspection.
- No `.factory/services.yaml` service manifest is present in this repo; no runtime services are required for this milestone's user-surface checks.

## Setup Notes

- Working directory: `/home/paul/oh-my-claudecode`
- Dependencies are already installed (`node_modules` present).
- No seed step required for these assertions.

## Validation Concurrency

- `vitest-shell`: **max concurrent validators = 1**
  - Reason: all assertions share the same repository workspace and test runner state; serial execution avoids log interleaving and shared-state interference.

## Flow Validator Guidance: vitest-shell

Isolation boundaries for subagents on this surface:

1. Use only the assigned repository path and assertion list.
2. Do not modify source code; validation run is read/execute only.
3. Write outputs only to assigned flow report and evidence directories.
4. Prefer targeted commands for assigned assertions, then summarize outcomes with exact command evidence.

Suggested assertion checks for milestone `data-integrity` (Vitest 4.0.18 note: use file-targeted runs; `--grep` is unsupported):

- `VAL-DATA-001`: `npx vitest run src/__tests__/tools/ast-tools.test.ts`
- `VAL-DATA-002`: `npx vitest run src/installer/__tests__/claude-md-merge.test.ts`
- `VAL-DATA-003`: inspect `scripts/persistent-mode.mjs` for tail-read pattern (`openSync` + `readSync` from end of file)
- `VAL-DATA-004`: `npx vitest run src/__tests__/hud/background-tasks.test.ts`
- `VAL-DATA-005`: `npx vitest run src/__tests__/hud/background-cleanup.test.ts`
- `VAL-DATA-006`: inspect `templates/hooks/keyword-detector.mjs` for `prompt` field usage in `ralph` state
