---
name: backend-pipeline
description: End-to-end backend/engine pipeline for a single feature — constitution check → strategic gate → requirements analysis → conditional technology strategy/provisioning → architecture → plan review → implementation → performance & security audits → verification
argument-hint: "<feature description>"
level: 4
---

# Backend Pipeline Skill

Backend/engine counterpart to `product-pipeline`. Orchestrates the full non-UX agent chain for a single backend feature request. Replaces UX-specific stages (ux-researcher, ux-architect, accessibility-auditor) with backend-specific equivalents (analyst, architect, security-reviewer, performance-guardian in backend-budget mode). Stops at HARD STOPs and reports reason plus remediation before advancing.

## Usage

```
/oh-my-claudecode:backend-pipeline <feature description>
/backend-pipeline <feature description>
```

### Examples

```
/backend-pipeline "add idempotent webhook ingestion with at-least-once delivery to workers"
/backend-pipeline "rate-limit auth endpoints per IP and per account with Redis token buckets"
/backend-pipeline "implement CDC from primary postgres to analytics warehouse with <5s lag"
/backend-pipeline "replace in-memory job queue with durable queue + DLQ + replay"
```

### Flags

- `--skip-ralplan` — skip consensus plan review in Phase 4 (not recommended for Type-1 irreversible changes).
- `--security-depth=<standard|deep>` — deep triggers security-reviewer threat-model pass plus targeted abuse cases (default: standard).
- `--perf-budget=<path>` — path to explicit budget file (throughput, latency percentiles, memory ceiling); if absent, agent infers from constitution and flags gaps.
- `--parallel-tests` — run test-engineer in parallel with executor (default sequential; parallel is faster but produces more coordination load).

<Purpose>
Single command that takes a backend feature request and runs it through constitution → strategic gate → requirements analysis → conditional technology strategy/provisioning → architecture → plan review → implementation with tests → security and performance audits → verification. Stops at any HARD STOP (anti-goal violation, stack incompatibility, unresolved critical trade-off, plan REJECTED by critic, security CRITICAL finding, performance budget breach, verifier REJECTED) and reports the reason and remediation path before proceeding.
</Purpose>

<Use_When>
- Feature has no new UX surface or has a UX surface handled separately (e.g., API endpoint, background job, schema migration, engine component, integration, data pipeline).
- Changes touch correctness-critical paths: auth, payments, data integrity, distributed state, concurrency, persistence, transport.
- Performance or security budgets are load-bearing for the change.
- Multi-file changes across services, workers, or modules.
- User invokes `/backend-pipeline` directly.
</Use_When>

<Do_Not_Use_When>
- Feature is user-facing with new screens or interactions — use `/oh-my-claudecode:product-pipeline`.
- Trivial config/env change — use executor directly.
- Pure refactor with no behavior change — use architect → executor.
- Debugging an existing issue — use `/oh-my-claudecode:debug` or debugger agent.
- Exploration/research with no implementation intent — use `/oh-my-claudecode:sciomc` or explore.
</Do_Not_Use_When>

<Why_This_Exists>
`product-pipeline` enforces non-skippable UX gates (ux-architect macro flow, accessibility-auditor critical findings, copywriter pre-pass) that are load-bearing for user-facing work and noise for backend engines. Running backend features through product-pipeline either fails at Stage 4 (no UX flow to specify) or produces bloated artifacts for nothing.

Conversely, running backend features through ad-hoc executor invocation skips the gates that matter most for backend: explicit anti-goal check, formal requirements analysis, architecture pass before planning, plan review before build, security audit, performance-budget enforcement. Each skipped gate compounds; the typical failure is a migration that passed review but broke production under load, or an API that shipped secure-looking code with an authorization bypass that review missed because there was no dedicated security pass.

This skill encodes the minimum backend quality chain as non-skippable stages with HARD STOPs at the points where bypass costs are asymmetric (irreversible, security-sensitive, correctness-critical). Every stage's output is the next stage's verified input.
</Why_This_Exists>

<Pipeline_Stages>

## Stage 1 — Foundation Check

**Agent:** brand-steward (invoked only if constitution absent / draft AND no interaction this session)
**Input:** `.omc/constitution.md`
**Output:** Constitution status confirmation.

**Protocol:**
1. Read `.omc/constitution.md`.
2. If absent or `status: draft` AND brand-steward not run this session → warn user and recommend `/oh-my-claudecode:brand-steward`. Proceed with artifacts tagged UNVALIDATED-AGAINST-CONSTITUTION.
3. If `status: partial` → warn that anti-goal gate has gaps; proceed.
4. If `status: complete` → proceed silently.

**HARD STOP:** None by default. `OMC_SKIP_HOOKS` skips the warn-and-recommend step.

---

## Stage 2 — Strategic Gate

**Agent:** product-strategist
**Input:** Feature description + `.omc/constitution.md`
**Output:** `.omc/strategy/YYYY-MM-DD-<slug>.md`

**Protocol:**
1. Invoke `oh-my-claudecode:product-strategist`.
2. Agent evaluates feature against anti-goals, principles, scope boundaries. Backend features can and do violate anti-goals (e.g., anti-goal "we never store user content" blocks a caching-layer design that stores payloads).
3. Result: APPROVED / APPROVED WITH RISKS / NEEDS CLARIFICATION / BLOCKED.

**HARD STOP:** Result is BLOCKED (anti-goal violation). Report verbatim anti-goal quote. User must update constitution via brand-steward or revise feature.

**HARD STOP:** Result is NEEDS CLARIFICATION with a blocking open question.

**Proceed:** APPROVED or APPROVED WITH RISKS.

---

## Stage 3 — Requirements Analysis

**Agent:** analyst
**Input:** Feature description + strategy report + constitution
**Output:** `.omc/requirements/YYYY-MM-DD-<slug>.md`

**Protocol:**
1. Invoke `oh-my-claudecode:analyst` with the feature and strategy context.
2. Agent produces: functional requirements, non-functional requirements (throughput, latency targets, durability, consistency model, failure modes), acceptance criteria (testable), open questions, explicit out-of-scope list.
3. For backend: must specify the consistency model (strong / read-your-writes / eventual / causal), failure semantics (at-most-once / at-least-once / exactly-once), and state-ownership boundaries.

**HARD STOP:** Open questions block implementability (analyst marks them HIGH-severity). User resolves before planning.

**HARD STOP:** Acceptance criteria are not testable (vague NFRs like "should be fast"). Analyst must rewrite with measurable thresholds or HARD STOP.

---

## Stage 3.5 — Capability & Stack Preflight (Conditional)

**Agents:** technology-strategist → document-specialist (conditional researcher) → critic → stack-provision (conditional)
**Input:** Feature description + Stage 2 strategy report + Stage 3 requirements + `.omc/constitution.md` + current stack/provisioning context
**Output:** `.omc/decisions/YYYY-MM-DD-technology-<slug>.md` + optional `.omc/provisioned/runs/<run-id>/manifest.json`

**Skip condition:** skip only when an accepted technology ADR and verified provisioning manifest already cover every backend capability block introduced by the requirements. Coverage must include the relevant application blocks, operational practices, and surfaces, not only the framework names already in `package.json`.

**Protocol:**
1. Invoke `technology-strategist` with requirements, strategy artifact, known stack, and current provisioning manifest.
2. Technology Strategist enumerates application blocks such as auth, authorization, background jobs, telemetry, analytics, billing, ledgers, integrations, data pipelines, search, caching/rate-limiting, and compliance triggers.
3. It produces fixed-weight scorecards, pairwise compatibility report, risk register, and handoff-envelope v2.
4. If `requirements_completeness < 0.75` or `unknown_critical_inputs >= 2`, route to `/deep-interview` or analyst clarification and pause before architecture.
5. If `top2_score_gap < 8`, critical compatibility is `unknown`, or fresh external evidence is missing, route to `document-specialist` researcher before critic.
6. Run critic on the technology ADR. Only `approve` may proceed. `revise` returns to technology-strategist; `rewind` hard-rewinds to capability-map and invalidates downstream artifacts.
7. Run `stack-provision` in Strict Gate mode when the approved ADR introduces missing skills, new technologies, or new capability surfaces.

**HARD STOP:** Any critical compatibility pair is `blocked`, including ABI/FFI conflict, runtime/toolchain mismatch, license conflict, or observability/deploy incompatibility.

**HARD STOP:** Critic verdict is not `approve` after allowed revise/rewind cycles.

**HARD STOP:** Strict Gate cannot approve required skills/professional guidance for a critical backend block.

**Proceed:** ADR is approved and either existing provisioning covers the requirements or new provisioning is verified.

---

## Stage 4 — Architecture Design

**Agent:** architect (opus, READ-ONLY)
**Input:** Requirements artifact + existing codebase
**Output:** `.omc/architecture/YYYY-MM-DD-<slug>.md`

**Protocol:**
1. Invoke `oh-my-claudecode:architect` with the requirements path and scope.
2. Agent reads existing code (file:line evidence mandatory), identifies integration points, proposes architecture options with trade-offs, names the recommended option with rationale, lists risks and their mitigations.
3. For each option: state the reversibility class (Type-1 irreversible / Type-2 reversible), the consistency model implications, and the failure-mode envelope.
4. Artifact MUST name at least 2 options and explain why the recommended one wins.

**HARD STOP:** Architect identifies an unresolved critical trade-off (e.g., requirements mandate exactly-once but available primitives only provide at-least-once). Pipeline halts with the trade-off; user resolves by either loosening requirements (back to Stage 3) or accepting a compensating control.

**HARD STOP:** Architect produces a single-option "plan" with no alternatives considered. Re-run with explicit directive to produce ≥2 options.

---

## Stage 5 — Plan Review

**Agent:** planner + critic (via `/oh-my-claudecode:ralplan` for consensus mode) — unless `--skip-ralplan`
**Input:** Architecture artifact + requirements + codebase
**Output:** `.omc/plans/YYYY-MM-DD-<slug>.md` (approved plan)

**Protocol:**
1. Invoke `oh-my-claudecode:planner` with architecture + requirements. Planner produces concrete, implementable steps with file:line references.
2. Invoke `oh-my-claudecode:critic` on the plan — standard ralplan rigor (pre-mortem, assumption extraction, gap analysis, dependency audit, test-plan expansion).
3. If critic verdict is REJECT or REVISE → planner revises; loop until critic PASS or max 3 iterations.
4. For Type-1 irreversible changes (schema migrations, data model changes, auth-layer changes, contract breaks), `--skip-ralplan` is ignored — ralplan is mandatory.

**HARD STOP:** Critic REJECTs after 3 revision iterations. Report the persistent rejection reason; user escalates to architect for re-design or revises requirements.

**HARD STOP:** Plan targets a Type-1 irreversible change without a rollback plan. Rollback section is non-negotiable for Type-1.

---

## Stage 6 — Implementation

**Agents:** executor (opus for complex logic; sonnet for straightforward) + test-engineer — coordinated via `/team`
**Input:** Approved plan + architecture + requirements
**Output:** Modified/created source files + test files.

**Protocol:**
1. Create a team session.
2. Task: executor implements per plan. Use opus model when: (a) concurrency, (b) distributed state, (c) non-trivial algorithm, (d) security-sensitive path, (e) migration logic. Sonnet otherwise.
3. Task: test-engineer authors tests per the acceptance criteria from Stage 3 — unit, integration, and at least one e2e/contract test per new surface. Include failure-mode tests (timeouts, partial failures, retries).
4. Default: test-engineer sequential after executor (clean deps). `--parallel-tests` runs them in parallel using stub contracts from the plan.
5. Stage handoff written to `.omc/handoffs/backend-pipeline-stage6.md`.

**HARD STOP:** Executor cannot implement per plan (plan has hidden gaps). Route back to planner with specific gap description; do not improvise the missing plan steps in executor.

**HARD STOP:** test-engineer cannot author tests for an acceptance criterion (criterion is not testable). Route back to analyst to rewrite the criterion.

---

## Stage 7 — Quality Bar (parallel)

**Agents:** security-reviewer ‖ performance-guardian (backend-budget mode)
**Input:** Source files modified in Stage 6 + requirements (for budgets and threat surfaces)
**Output:** `.omc/audits/YYYY-MM-DD-security-<slug>.md` + `.omc/audits/YYYY-MM-DD-perf-<slug>.md`

**Protocol:**
1. Run both agents in parallel via `/team`.
2. **security-reviewer**: OWASP applicability, authn/authz checks, input validation, secrets handling, injection surfaces, SSRF, deserialization, rate-limit / abuse, auditability. Depth controlled by `--security-depth`. For `deep`: add STRIDE threat-model pass and explicit abuse-case enumeration.
3. **performance-guardian (backend-budget mode)**: invoked with explicit directive: "Run in backend-budget mode. Measure: throughput (req/s target from requirements), p50/p95/p99 latency, memory footprint under load, connection-pool saturation, lock contention, query cost under representative N, tail-latency under degraded dependencies. Do NOT measure Core Web Vitals — not applicable to backend surfaces." If `--perf-budget` provided, enforce those thresholds; otherwise use NFRs from Stage 3.
4. Both write audit reports.

**HARD STOP:** security-reviewer reports CRITICAL finding (authn/authz bypass, injection on a user-input path, secret in source, remote-code-execution surface). Pipeline halts. Remediation required before Stage 8.

**HARD STOP:** performance-guardian reports budget breach marked as blocking (NFR from Stage 3 not met).

**Proceed:** All CRITICAL resolved. MAJOR / MINOR tracked as follow-up.

---

## Stage 8 — Verification

**Agent:** verifier + code-reviewer (code-reviewer is opus; mandatory for Type-1 changes)
**Input:** Stage 6 source files + Stage 7 audit reports
**Output:** Final verdict.

**Protocol:**
1. Invoke `oh-my-claudecode:verifier` on the implementation against the requirements artifact — every acceptance criterion has a passing test.
2. Invoke `oh-my-claudecode:code-reviewer` (opus) on the diff — multi-perspective review (security / new-hire / ops), gap analysis ("what's MISSING"), concrete fixes for CRITICAL and MAJOR findings.
3. For Type-1 irreversible changes: code-reviewer is mandatory regardless of `--skip-*` flags.
4. Produce APPROVED or REJECTED verdict with evidence.

**HARD STOP:** verifier or code-reviewer returns REJECTED. User resolves and re-runs Stage 8 only (resume; do not restart from Stage 1).

---

## Stage 9 — Consolidated Report

**Agent:** lead (skill orchestrator)
**Input:** All prior stage outputs
**Output:** Terminal summary + pointer to artifacts.

```markdown
## Backend Pipeline Report: <feature>

**Date:** YYYY-MM-DD
**Pipeline result:** APPROVED / REJECTED / HALTED AT STAGE N

### Stage Results
| Stage | Status | Output |
|---|---|---|
| 1. Foundation | Pass / Skipped / HARD STOP | `.omc/constitution.md` |
| 2. Strategic Gate | APPROVED / APPROVED WITH RISKS / BLOCKED | `.omc/strategy/*.md` |
| 3. Requirements | Complete / HARD STOP | `.omc/requirements/*.md` |
| 3.5. Capability & Stack Preflight | Approved / Skipped / HARD STOP | `.omc/decisions/*.md` + `.omc/provisioned/**` |
| 4. Architecture | Complete / HARD STOP | `.omc/architecture/*.md` |
| 5. Plan Review | PASS / HARD STOP | `.omc/plans/*.md` |
| 6. Implementation | Complete | [file list] |
| 7. Security Audit | PASS / HARD STOP | `.omc/audits/security-*.md` |
| 7. Performance Audit | PASS / HARD STOP | `.omc/audits/perf-*.md` |
| 8. Verification | APPROVED / REJECTED | verifier + code-reviewer |

### Architecture Decision
<recommended option + reversibility class>

### Acceptance Criteria Coverage
<table: criterion → test file:line>

### Security Findings
<CRITICAL resolved / MAJOR / MINOR>

### Performance Budget
<budget → measured → verdict>

### Risks and Follow-up
<MAJOR/MINOR from audits, open items>
```

</Pipeline_Stages>

<Execution_Policy>
- Each stage is non-skippable except noted (Stage 5 `--skip-ralplan` for non-Type-1 only; Stage 1 skippable via `OMC_SKIP_HOOKS`).
- HARD STOPs halt the pipeline. Lead reports reason + verbatim quote of the violated constraint + required remediation. No stage advances past a HARD STOP.
- Stages 6 and 7 use `/team` for coordination. Other stages are sequential single-agent invocations.
- Handoff files in `.omc/handoffs/backend-pipeline-<stage>.md` enable resumption after a HARD STOP — re-invocation reads handoffs and resumes from the halted stage.
- Stage 3.5 uses the Team pipeline strategy subphases for backend-pipeline profile: `intake -> capability-map -> weighted-ranking -> compatibility-check -> research(optional) -> critic-gate -> provision-plan -> provision-verify`.
- Type-1 irreversible changes trigger mandatory rigor: ralplan in Stage 5, code-reviewer in Stage 8, explicit rollback plan in Stage 5 output.
- Composable with `/oh-my-claudecode:ralph` for retry-on-transient-failure: `/ralph /backend-pipeline "..."`.
- Composable with `/oh-my-claudecode:autopilot` downstream of ideate — pipe a shortlist backend-track idea directly into this pipeline after prioritization.
</Execution_Policy>

<Input_Contract>
Primary argument: the feature description string.

Quality input characteristics:
- States a concrete backend capability, not a UI request.
- Names the surface (API / worker / schema / pipeline / integration).
- Mentions load-bearing NFRs when known (throughput, latency target, consistency, durability).
- Describes failure-mode expectations (what happens on crash, partition, retry).

Vague inputs produce NEEDS CLARIFICATION at Stage 2 or Stage 3.
</Input_Contract>

<Output>
See Stage 9 Consolidated Report + stage-specific artifacts:

- `.omc/strategy/YYYY-MM-DD-<slug>.md`
- `.omc/requirements/YYYY-MM-DD-<slug>.md`
- `.omc/decisions/YYYY-MM-DD-technology-<slug>.md`
- `.omc/provisioned/runs/<run-id>/manifest.json` when new provisioning was required
- `.omc/architecture/YYYY-MM-DD-<slug>.md`
- `.omc/plans/YYYY-MM-DD-<slug>.md`
- `.omc/handoffs/backend-pipeline-stage{N}.md`
- `.omc/audits/YYYY-MM-DD-security-<slug>.md`
- `.omc/audits/YYYY-MM-DD-perf-<slug>.md`
- Source files modified or created (paths in Stage 6 handoff)
</Output>

<Failure_Modes_To_Avoid>
- **Skipping Stage 2 because "this is a backend change, constitution doesn't apply."** Anti-goals apply to backend too. A caching layer that stores user content violates a "we never store user content" anti-goal. The strategic gate is non-negotiable.
- **Skipping Stage 3.5 when backend requirements introduce a new capability block.** Auth, payments, analytics, telemetry, data pipelines, queues, search, ledgers, or integrations have stack and skill implications. Architect should design against approved technology decisions, not invent them mid-plan.
- **Skipping Stage 4 (architecture) and going straight from requirements to plan.** Plans that skip architecture lock in accidental design choices. Architect must produce ≥2 options with reversibility classes before planner commits to one.
- **Using `--skip-ralplan` on a Type-1 irreversible change.** Silently ignored by the skill — Type-1 changes always get ralplan regardless of flag.
- **Treating performance-guardian as UI-focused.** Explicit backend-budget invocation is mandatory (Stage 7 protocol). Without it, the agent defaults to Core Web Vitals and produces irrelevant output.
- **Running Stage 7 sequentially instead of parallel.** Security and performance are independent; serial execution doubles wall-clock for no benefit.
- **Marking pipeline complete when security-reviewer flagged CRITICAL.** CRITICAL ≠ follow-up. It is a HARD STOP. Same for authorization bypasses, secrets in source, and input-validation gaps on user-reached paths.
- **Accepting acceptance criteria that are not testable.** "Should be fast" is not a criterion. Analyst must rewrite with thresholds or HARD STOP at Stage 3.
- **Using this pipeline for UI work.** Missing ux-architect and accessibility-auditor gates. Use product-pipeline.
- **Skipping rollback-plan requirement for Type-1.** Schema migrations without a tested rollback are how production incidents become unrecoverable. Stage 5 enforces rollback plan for Type-1.
- **Running executor with sonnet on concurrency/distributed-state code.** Concurrency bugs are non-deterministic and expensive to catch post-ship; opus cost is trivial relative to incident cost.
- **Bypassing code-reviewer on Type-1.** Second-pair-of-eyes is structurally separate from verifier (different prompt, different perspective). Not interchangeable.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Reuses existing OMC agents: brand-steward, product-strategist, analyst, architect, planner, critic (via ralplan), executor, test-engineer, security-reviewer, performance-guardian, verifier, code-reviewer.
- Reuses `/team` infrastructure for Stages 6 and 7 — see `skills/team/SKILL.md`.
- Reuses `/oh-my-claudecode:ralplan` for Stage 5 consensus plan review.
- Uses `technology-strategist` and `stack-provision` as a conditional pre-architecture gate. For a new product or major pivot, run `/product-foundation` first so this pipeline receives current market, constitution, ADR, and provisioning context.
- Composes with `/oh-my-claudecode:ideate` upstream — shortlist ideas with `--track=backend` flow into this skill post-prioritization.
- Composes with `/oh-my-claudecode:priority-engine` upstream — ranked backend items enter this pipeline in order.
- Composes with `/oh-my-claudecode:autopilot` as an alternative for fully-autonomous mode once the plan is approved (Stage 5 handoff → autopilot executes Stages 6–8).
- **Known limitation**: `performance-guardian` agent prompt is UI-oriented (Core Web Vitals). This skill compensates by passing an explicit backend-budget directive in Stage 7. If you frequently run backend features, consider forking a `backend-performance-guardian` agent with backend-first prompt (throughput/latency/memory/contention) for less invocation ceremony.
- **Reversibility framing** (Stages 4 and 5) follows Bezos Type-1 / Type-2: Type-1 decisions warrant maximum scrutiny (ralplan + code-reviewer mandatory + rollback plan); Type-2 decisions can move faster under `--skip-ralplan`.
- For existing codebases, consider running `/oh-my-claudecode:trace` before this pipeline to surface hidden dependencies the architect would miss.
- For greenfield backends, consider running `/oh-my-claudecode:ideate` with `--track=backend` first — this pipeline is convergent, not generative.
</Integration_Notes>
