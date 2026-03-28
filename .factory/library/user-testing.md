# User Testing Knowledge

## Surface
- This repository is a CLI/library project for OMC orchestration.
- Security milestone assertions are validated through regression tests that exercise real CLI/library behavior.

## Setup
- Dependencies are expected in `node_modules` (`npm ci` when missing).
- No external runtime services are required for security assertion validation.

## Validation Concurrency
- `cli-vitest`: max concurrent validators = 1
  - Reason: all assertions share the same git workspace and test cache; serial execution avoids interleaving test output and shared-state flakiness.

## Flow Validator Guidance: cli-vitest
- Isolation boundary: assigned assertion IDs only.
- Do not modify source code or tests.
- Store report at `.factory/validation/security/user-testing/flows/<group-id>.json`.
- Save command output evidence under the assigned mission evidence directory.
- Run only assertion-scoped validation commands and report exact command, exit code, and observed output.

## Tooling Notes
- In this workspace (Vitest `v4.0.18`), `npx vitest run --grep "<pattern>"` fails with `CACError: Unknown option '--grep'`.
- Use assertion-scoped test-file execution as fallback (for example `npx vitest run src/__tests__/project-memory-merge.test.ts`) and keep failed `--grep` command output as friction evidence.
