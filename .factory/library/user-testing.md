## User Testing Knowledge Base

### Project Surface
- This repository is a CLI/library project; user validation is done via command-line test/verification flows.
- Primary user-testing surface for current milestones: `vitest-cli`.

### Environment Setup
- No runtime services are required for race-condition user testing.
- `.factory/services.yaml` currently defines `services: []`.
- Required project dependencies are already installed in the workspace.

### Validation Commands
- Prefer project-root scoped commands:
  - `npm --prefix /home/paul/oh-my-claudecode exec vitest run --grep "<pattern>"`
  - Fallback when grep compatibility varies: run specific test files directly with `npx vitest run <path>`.
- Observed on this mission: `npm ... vitest run --grep "shared-state"` returned `No test files found`; reliable fallback was file-targeted execution against `__tests__/race-condition-fixes.test.ts` with `--testNamePattern`.

### Validation Concurrency
- `vitest-cli`: **max concurrent validators = 1**
  - Reason: validators operate on a shared working tree, shared cache, and can contend on I/O; serialization avoids flaky interference.

## Flow Validator Guidance: vitest-cli

### Isolation Boundary
- Stay within `/home/paul/oh-my-claudecode`.
- Write report only to assigned flow JSON path under `.factory/validation/<milestone>/user-testing/flows/`.
- Write evidence only to assigned mission evidence directory.

### Allowed Actions
- Run targeted `vitest` commands for assigned assertion IDs.
- Run read-only code inspection commands (`rg`, `jq`, `cat`) needed to map evidence to assertions.

### Disallowed Actions
- Do not edit source code or tests.
- Do not write outside assigned flow/evidence paths.
- Do not run broad destructive git or filesystem commands.
