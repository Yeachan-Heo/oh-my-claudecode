# User Testing Knowledge Base

## Surface Overview
- Project surface for validation contract assertions is CLI/test runner based.
- No web server or seeded database is required for `critical-logic` assertions.
- Required tool: `vitest` (targeted runs by assertion area).

## Setup Notes
- Dependencies are already installed in `/home/paul/oh-my-claudecode/node_modules`.
- No runtime services need to be started for current milestone assertions.
- In this repo, `npx vitest run --grep ...` can fail with `Unknown option --grep`; use targeted test-file runs (or `npm --prefix /home/paul/oh-my-claudecode exec vitest run --grep ...` when supported).

## Validation Concurrency
- Surface: `vitest-cli`
- Max concurrent validators: `2`
- Rationale: tests are isolated by file pattern and host has ample free memory/CPU; running more than 2 concurrent Vitest workers could create noisy contention without reducing wall time materially.

## Flow Validator Guidance: vitest-cli
- Isolation boundary: only operate inside `/home/paul/oh-my-claudecode`.
- Do not modify source files, tests, or mission definitions.
- Run only assigned assertion commands; collect command output as evidence.
- Write flow report JSON to `.factory/validation/<milestone>/user-testing/flows/<group-id>.json`.
- Save any extra logs to mission evidence path provided by coordinator.
