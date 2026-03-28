# User Testing Knowledge Base

## Project Surface
- This repository is a CLI/library project.
- User-surface validation for this mission is done via Vitest-based regression tests (no browser UI flow).

## Setup
- Required runtime: Node.js + npm dependencies in `node_modules/`.
- If dependencies are missing, run: `npm ci`.
- No dedicated app service startup is required for assertion validation in milestone `minor-fixes`.
- Vitest in this repo (`v4.0.18`) does **not** support `--grep`; use `-t "<pattern>"` for targeted test selection.

## Validation Concurrency
- **Surface:** `vitest`
- **Max concurrent validators:** `2`
- **Rationale:** targeted Vitest runs are independent but CPU-intensive; limit to 2 parallel workers for stable execution.

## Flow Validator Guidance: vitest
- Stay within assigned assertion IDs only.
- Use only targeted test commands (`npx vitest run -t "<pattern>"`) relevant to assigned assertions.
- Do not run full-suite tests in flow-validator subagents.
- Write report JSON only to assigned flow report file under:
  - `.factory/validation/<milestone>/user-testing/flows/`
- Write evidence files only to assigned mission evidence directory under:
  - `/home/paul/.factory/missions/5e80e9fa-ddca-4b4b-a19c-13a029424c2c/evidence/<milestone>/<group-id>/`
- Do not modify source code, business logic, or unrelated files.
