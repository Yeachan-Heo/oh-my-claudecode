# Consolidation Phase 3+ Roadmap

## Context

Phase 2 landed alias-based consolidation and Tier-0 contract protection for:

- `ralplan`
- `team`
- `ralph`
- `ultrawork`
- `autopilot`

This roadmap defines the next wave: agent utilization cleanup, routing simplification, and migration governance.

## Goals

1. Reduce agent surface area without breaking compatibility.
2. Improve routing quality (right agent, right tier, less idle/duplicate delegation).
3. Formalize deprecation policy and rollout safety gates.

## Scope

### 1) Agent Catalog Consolidation

- Build canonical lanes:
  - discovery
  - planning/analysis
  - implementation
  - verification/review
- Mark legacy/overlapping roles as compatibility aliases.
- Keep stable compatibility map for old names.

### 2) Routing and Utilization

- Add explicit routing matrix from skill families -> canonical agent lanes.
- Add telemetry signals for:
  - invocation count
  - completion rate
  - retry rate
  - escalation rate
- Define thresholds for “keep / merge / deprecate”.

### 3) Migration Governance

- Tier classes:
  - Tier-0: immutable public contracts (already enforced)
  - Tier-1: stable core
  - Tier-2: consolidation candidates
- Two-release minimum deprecation window for non-Tier-0 names.
- Rollback guardrails via routing manifest toggles.

## Acceptance Criteria

- Canonical agent matrix documented and linked from `docs/REFERENCE.md`.
- Compatibility aliases remain functional for existing names.
- Regression tests cover:
  - alias fidelity
  - protected mode invariants
  - docs/runtime parity checks
- No regression to Tier-0 behavior.

## Proposed Delivery Plan

### Milestone A — Discovery + Metrics

- Inventory current agent usage and overlap.
- Propose keep/merge/deprecate candidates with evidence.

### Milestone B — Runtime Routing Cleanup

- Implement routing table changes + compatibility aliases.
- Add targeted tests for agent resolution behavior.

### Milestone C — Docs + Migration Policy

- Publish deprecation schedule and migration notes.
- Update AGENTS/docs consistency checks.

### Milestone D — Validation Gate

- Run full verification:
  - `npm test`
  - `npm run build`
  - `npm run lint`
- Validate no Tier-0 regressions.

## Risks

- Over-pruning specialized agents can reduce quality on edge tasks.
- Hidden coupling between hooks and specific agent names.
- Docs drift if naming changes are not synchronized.

## Risk Controls

- Alias-first migration (never hard-remove first).
- Protected-mode regression suite required on every consolidation PR.
- Incremental rollout with clear rollback path.
