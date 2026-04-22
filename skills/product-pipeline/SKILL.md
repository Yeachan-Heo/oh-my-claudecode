---
name: product-pipeline
description: End-to-end product-quality pipeline for a single feature request — constitution check → strategic gate → conditional technology strategy/provisioning → UX research → UX flow design → implementation → quality audit → verification
argument-hint: "<feature description>"
level: 4
---

# Product Pipeline Skill

Orchestrates the full product-quality agent chain for a single feature request. Runs non-skippable gates from brand constitution check through accessibility and performance audits. Stops at any HARD STOP and reports the reason plus remediation path before proceeding.

## Usage

```
/oh-my-claudecode:product-pipeline <feature description>
/product-pipeline <feature description>
```

### Examples

```
/product-pipeline "add ability to share knit patterns with other users"
/product-pipeline "build a CSV export for the reporting dashboard"
/product-pipeline "let users set notification preferences per project"
```

<Purpose>
Single command that takes a feature request and runs it through the full product-quality chain: constitution check → strategic gate → conditional technology strategy/provisioning → UX flow design → component implementation → quality audit. Stops at any HARD STOP (anti-goal violation, stack incompatibility, accessibility critical, performance budget breach) and reports back with the reason and the required remediation path before the user can proceed.
</Purpose>

<Use_When>
- User describes a new feature or change ("add X", "build Y feature", "let's create Z")
- User invokes `/product-pipeline` directly
- Multiple feature ideas need consistent quality-gate evaluation before prioritization
- Team wants to ensure no gate is skipped when shipping a feature end-to-end
</Use_When>

<Do_Not_Use_When>
- Bug fixes with no new UX surface — use `/team` or invoke executor directly
- Refactors with no UX impact — use executor
- Pure research or exploration questions — use `ideate` or `external-context`
- Implementation is already approved and fully detailed — skip pipeline, invoke executor
- The feature was already run through the pipeline this session and a HARD STOP was cleared — resume from the halted stage rather than restarting
</Do_Not_Use_When>

<Why_This_Exists>
Without an orchestrated pipeline, users invoke product agents ad-hoc and forget steps: skip the strategist gate, skip accessibility audit, skip performance check. Anti-goal violations slip through undetected. UX architecture decisions get made implicitly by designers without macro-flow documentation. Accessibility findings surface after 20 components are already built.

This skill makes every gate non-skippable. Each stage's output becomes the next stage's verified input. A HARD STOP is a wall, not a suggestion.
</Why_This_Exists>

<Pipeline_Stages>

## Stage 1 — Foundation Check

**Agent:** brand-steward (invoked if constitution is absent or draft)
**Input:** `.omc/constitution.md` (read-only check)
**Output:** `.omc/constitution.md` (written by brand-steward if absent/draft)

**Protocol:**
1. Read `.omc/constitution.md`.
2. If the file is absent or `status: draft` AND no user has interacted with brand-steward this session → invoke `oh-my-claudecode:brand-steward` to conduct the discovery interview. Pipeline is paused until constitution reaches at least `status: partial`.
3. If `status: partial` → warn the user: "Constitution is partial — unfilled sections will produce UNVALIDATED findings downstream. Proceeding." Continue.
4. If `status: complete` → proceed immediately.

**HARD STOP:** Constitution is absent or `status: draft` AND brand-steward has not been run this session. User must complete at least a partial constitution before the pipeline advances.

---

## Stage 2 — Strategic Gate

**Agent:** product-strategist
**Input:** Feature description (from skill argument) + `.omc/constitution.md`
**Output:** `.omc/strategy/YYYY-MM-DD-<slug>.md`

**Protocol:**
1. Invoke `oh-my-claudecode:product-strategist` with the feature description.
2. Agent reads constitution, checks anti-goals, evaluates mission alignment, scope boundaries, and strategic risks.
3. Write evaluation report to `.omc/strategy/YYYY-MM-DD-<slug>.md`.

**HARD STOP:** If product-strategist returns evaluation result `BLOCKED` (anti-goal violation). Pipeline halts immediately. Report the verbatim anti-goal text and the conflict. User must either update the constitution via brand-steward or revise the feature before re-running the pipeline.

**HARD STOP:** If result is `NEEDS CLARIFICATION` with a blocking open question. Pipeline pauses until user resolves the question.

**Proceed:** result is `APPROVED` or `APPROVED WITH RISKS` (risks are documented in the handoff, not a stop condition).

---

## Stage 2.5 — Capability & Stack Preflight (Conditional)

**Agents:** technology-strategist → document-specialist (conditional researcher) → critic → stack-provision (conditional)
**Input:** Feature description + Stage 2 strategy report + `.omc/constitution.md` + compact brand/competitor/research context + `.omc/provisioned/current.json` when present
**Output:** `.omc/decisions/YYYY-MM-DD-technology-<slug>.md` + optional `.omc/provisioned/runs/<run-id>/manifest.json`

**Skip condition:** skip only when a current technology ADR and provisioning manifest already cover every capability block introduced by this feature. Coverage must be explicit: matching stack technologies, application blocks, and capability surfaces. "The project already uses React" is not enough when the feature introduces analytics, telemetry, auth, billing, generated media, 3D, realtime, or domain-specific workflow blocks.

**Protocol:**
1. Invoke `technology-strategist` with the feature, strategy artifact path, current stack, brand/constitution context, and known provisioned manifest.
2. Technology Strategist classifies the product/domain, maps application blocks, produces weighted scorecard, compatibility report, risk register, and handoff-envelope v2.
3. If `requirements_completeness < 0.75` or `unknown_critical_inputs >= 2`, route to `/deep-interview` and pause this pipeline until the missing inputs are resolved.
4. If `top2_score_gap < 8`, critical compatibility is `unknown`, or fresh external evidence is missing, route to `document-specialist` researcher before critic.
5. Run critic on the technology ADR. Only `approve` may proceed. `revise` returns to technology-strategist; `rewind` hard-rewinds to capability-map and invalidates downstream stack/provision artifacts.
6. If the approved ADR introduces new technologies, blocks, surfaces, or missing skills, run `stack-provision` in Strict Gate mode before Stage 3.

**HARD STOP:** Compatibility status is `blocked` for any critical path pair.

**HARD STOP:** Critic verdict is not `approve` after allowed revise/rewind cycles.

**HARD STOP:** `stack-provision` Strict Gate rejects required external skills and no safe local/bundled/generated fallback is approved.

**Proceed:** ADR is approved and either existing provisioning covers the feature or new provisioning is verified.

---

## Stage 3 — UX Research Synthesis (Optional)

**Agent:** ux-researcher
**Input:** `.omc/research/` directory (existing files), `.omc/constitution.md`, feature context
**Output:** `.omc/research/YYYY-MM-DD-<topic>.md`

**Skip condition:** Glob `.omc/research/` — if no existing feedback files, support ticket exports, session recording summaries, or prior research artifacts are found, skip this stage and document the skip in the handoff: "Stage 3 skipped: no existing user data sources detected."

**Protocol (when not skipped):**
1. Invoke `oh-my-claudecode:ux-researcher` with the feature context and any detected research inputs.
2. Agent synthesizes existing evidence, runs heuristic evaluation if UI code is in scope, and documents evidence gaps as study plans.
3. Write research artifact to `.omc/research/YYYY-MM-DD-<topic>.md`.
4. Pass synthesis findings to Stage 4 as grounding context.

**HARD STOP:** None. Research is advisory; findings inform but do not block the flow. Document all gaps as study plan items for the user to execute post-launch.

---

## Stage 4 — Macro Flow Design

**Agent:** ux-architect
**Input:** Feature description + Stage 2 strategy report + Stage 3 research findings (if present) + `.omc/constitution.md`
**Output:** `.omc/ux/YYYY-MM-DD-<feature>.md`

**Protocol:**
1. Invoke `oh-my-claudecode:ux-architect` with full context (feature description, strategy report path, research artifact path if present).
2. Agent maps entry points, defines all screen states (loading / empty / partial / success / error / unauthorized / expired), traces decision nodes, documents navigation hierarchy, and writes the flow spec.
3. Write flow spec to `.omc/ux/YYYY-MM-DD-<feature>.md`.

**HARD STOP:** If ux-architect cannot define all of: error state, unauthorized state, and empty state for every screen in scope. These are non-negotiable. Pipeline halts and reports: "UX flow spec incomplete — [list of undefined states]. Resolve these before designer implementation begins."

---

## Stage 5 — Implementation

**Agents:** copywriter (pre-pass, user-facing strings only) + designer (component-level) + executor (wiring + state management)
**Input:** `.omc/ux/YYYY-MM-DD-<feature>.md` + `.omc/constitution.md` + `.omc/strategy/YYYY-MM-DD-<slug>.md`
**Output:** Modified/created source files (paths documented in handoff)

**Protocol:**
1. **Pre-pass (copywriter):** If the feature is user-facing (any screen or notification text), invoke `oh-my-claudecode:copywriter` first to produce in-app string drafts aligned with the constitution's tone of voice. Strings are passed to designer as inputs, not left to implementation-time improvisation.
2. **Coordinated implementation:** Use the current OMC `/team` surface or CLI-first `omc team ...` runtime to run designer and executor in one coordinated session. Do not use deprecated MCP team-runtime calls.
   - designer: implements component-level UI for all states documented in the UX flow spec
   - executor: wires state management, routing, auth guards, API calls, and data flow
   - dependencies: designer produces component contracts first; executor wires only against those contracts
3. Stage handoff written to `.omc/handoffs/product-pipeline-stage5.md` (files created/modified, known gaps).

**HARD STOP:** Designer must not begin until Stage 4 UX flow spec exists. Executor must not wire state management until designer has produced the component interfaces. Coordinate via task dependencies in the `/team` session.

---

## Stage 6 — Quality Bar

**Agents:** accessibility-auditor + performance-guardian (parallel)
**Input:** Source files modified in Stage 5 + `.omc/constitution.md`
**Output:** `.omc/audits/YYYY-MM-DD-a11y-<scope>.md` + `.omc/audits/YYYY-MM-DD-perf-<scope>.md`

**Protocol:**
1. Run accessibility-auditor and performance-guardian in parallel over the files produced in Stage 5.
2. accessibility-auditor: WCAG 2.1 AA (or level from constitution), keyboard nav, ARIA, contrast ratios.
3. performance-guardian: bundle size impact, render budget, any documented performance constraints from the constitution.
4. Both write audit reports to `.omc/audits/`.

**HARD STOP:** If accessibility-auditor reports any CRITICAL finding (blocks task completion for assistive technology users). Pipeline halts. Report all CRITICAL findings with their WCAG criterion numbers and remediation paths. User must resolve via designer/executor before Stage 7.

**HARD STOP:** If performance-guardian reports a performance budget breach marked as blocking. Pipeline halts with breach details.

**Proceed:** All CRITICAL issues resolved. MAJOR and MINOR issues are documented in audit reports but do not block progression — they are tracked as follow-up work.

---

## Stage 7 — Verification

**Agent:** verifier or code-reviewer
**Input:** All Stage 5 source file changes + Stage 6 audit reports
**Output:** Final approval verdict

**Protocol:**
1. Invoke `oh-my-claudecode:verifier` (or `oh-my-claudecode:code-reviewer` for code-quality emphasis) for the final approval pass.
2. Verifier reviews: implementation against UX flow spec, audit report clearance, test coverage for new states, no debug artifacts.
3. Verifier produces APPROVED or REJECTED verdict with evidence.

**HARD STOP:** If verifier returns REJECTED. Pipeline halts with the verifier's specific rejection reasons. User resolves and re-runs Stage 7 only (no need to restart from Stage 1).

</Pipeline_Stages>

<Execution_Policy>
- Each stage is non-skippable except Stage 3 (UX Research — skipped if no user data sources detected via Glob).
- HARD STOPs always halt the pipeline. The lead reports the stop reason, the specific violated constraint (quoted verbatim where applicable), and the required remediation path. No stage advances past a HARD STOP.
- Pipeline runs as a `/team` session for Stage 5 coordination using the active OMC team runtime (`/team` or CLI-first `omc team ...`). All other stages run as sequential single-agent invocations.
- Stage handoffs written to `.omc/handoffs/product-pipeline-<stage>.md` (stages 1–7) for resumability. If the pipeline is re-invoked after a HARD STOP, it reads the handoff files to resume from the halted stage rather than restarting.
- Stage 2.5 uses the Team pipeline strategy subphases for product-pipeline profile: `intake -> capability-map -> weighted-ranking -> compatibility-check -> research(optional) -> critic-gate -> provision-plan -> provision-verify`.
- On cancellation (user runs `/cancel` or `OMC_SKIP_HOOKS` is set): shut down active workers through the current team runtime, mark the current stage as cancelled in its handoff file, and preserve all completed handoffs for resumption.
- Respects `OMC_SKIP_HOOKS` for testing and CI — when set, the pipeline skips brand-steward auto-interview and proceeds with constitution-draft warnings only.
- Can be linked with `/ralph` for retry-on-failure persistence: `/ralph /product-pipeline "feature description"` wraps the pipeline in Ralph's loop so HARD STOPs that resolve on retry are automatically retried without user intervention.
</Execution_Policy>

<Input_Contract>
The skill accepts a single string argument: the feature description.

```
/product-pipeline "add ability to share knit patterns with other users"
```

The description should be specific enough for product-strategist to evaluate against the constitution (what the feature does, who it serves, when it is used). Vague descriptions ("improve UX") will produce `NEEDS CLARIFICATION` halts at Stage 2.
</Input_Contract>

<Output>
Final pipeline report aggregating outputs from all completed stages:

```markdown
## Product Pipeline Report: [Feature Name]

**Date:** YYYY-MM-DD
**Feature:** [verbatim feature description]
**Pipeline result:** APPROVED / REJECTED / HALTED AT STAGE N

### Stage Results

| Stage | Status | Output |
|---|---|---|
| 1. Foundation Check | Pass / Skipped (partial) / HARD STOP | `.omc/constitution.md` |
| 2. Strategic Gate | APPROVED / APPROVED WITH RISKS / BLOCKED | `.omc/strategy/YYYY-MM-DD-<slug>.md` |
| 2.5. Capability & Stack Preflight | Approved / Skipped / HARD STOP | `.omc/decisions/*.md` + `.omc/provisioned/**` |
| 3. UX Research | Completed / Skipped (no data) | `.omc/research/YYYY-MM-DD-<topic>.md` |
| 4. Macro Flow Design | Complete / HARD STOP | `.omc/ux/YYYY-MM-DD-<feature>.md` |
| 5. Implementation | Complete | [list of files] |
| 6. Quality Bar | Pass / HARD STOP | `.omc/audits/YYYY-MM-DD-*.md` |
| 7. Verification | APPROVED / REJECTED | verifier report |

### Strategic Gate Verdict
[ship-now / ship-later / reject — from product-strategist]

### UX Flow Coverage
[list of screens + states documented]

### Implementation Summary
[files modified/created]

### Quality Audit Results
- Accessibility: pass/fail + critical count
- Performance: pass/fail + budget status

### Final Verifier Verdict
[APPROVED / REJECTED with evidence citation]

### Risks and Follow-up
[MAJOR/MINOR findings from quality audits, open research questions, study plans]
```
</Output>

<Failure_Modes_To_Avoid>
- **Skipping the strategic gate to save time.** This is the most common pipeline misuse. The strategic gate exists because anti-goal violations discovered post-implementation cost orders of magnitude more to reverse. Stage 2 is never optional.
- **Skipping Stage 2.5 when a feature introduces a new product block.** Product analytics, auth, telemetry, payments, retention mechanics, generated media, 3D, realtime, and visual-creative systems all change skill and technology requirements. Letting designer/executor choose these ad hoc breaks the stack governance model.
- **Continuing past a HARD STOP because the user pushes back.** A HARD STOP is not a recommendation. If the user wants to override it, they must update the constitution via brand-steward (for anti-goal conflicts) or resolve the specific issue (for accessibility/performance). The pipeline does not advance until the condition is cleared.
- **Running designer before ux-architect.** Skipping Stage 4 to reach Stage 5 faster produces components with no flow spec, no state inventory, and no error/unauthorized states. These gaps become production bugs.
- **Marking pipeline complete when accessibility-auditor reported CRITICAL findings.** CRITICAL findings block task completion for real users with disabilities. They are not "follow-up items" — they are HARD STOPs.
- **Using this pipeline for bug fixes.** Bug fixes have no UX architecture phase, no strategic scope gate, and no new component implementation. Running them through this pipeline over-engineers the process. Use executor directly.
- **Restarting from Stage 1 after a partial run.** Handoff files in `.omc/handoffs/` record completed stages. Always read handoffs before re-invoking — resume from the halted stage.
- **Invoking brand-steward during the pipeline if the constitution is already complete.** Brand-steward modifies the constitution. During a pipeline run, the constitution is an input contract. If a conflict is found, halt and report — do not silently update the constitution mid-run.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Uses the current `/team` infrastructure under the hood for Stage 5 — prefer the active slash-command surface or CLI-first `omc team ...` runtime exposed by the environment, not deprecated MCP runtime calls.
- Reads constitution status before every stage and passes constitution path to all agents that require it.
- Uses `technology-strategist` and `stack-provision` only as conditional preflight. For a greenfield product or major pivot, run `/product-foundation` first so this pipeline starts with current market/brand/stack artifacts.
- Refuses to proceed past Stage 1 if `status: draft` AND no brand-steward interaction has occurred this session. Check session state via `state_read` before auto-blocking.
- Respects `OMC_SKIP_HOOKS` for testing/CI — set this env var to skip the brand-steward auto-interview check and run the pipeline with draft-constitution warnings only.
- Handoff files at `.omc/handoffs/product-pipeline-stage{N}.md` are the resume mechanism. If the pipeline is interrupted (user cancels, process dies, HARD STOP), these files record exactly which stage completed and what its outputs were.
- Can be composed with `/ralph` for retry-on-failure persistence: `ralph` wraps the pipeline invocation in a loop that retries on transient failures (agent spawn errors, tool timeouts) and escalates to the architect agent after 3 consecutive failures on the same stage.
- Performance-guardian is a parallel peer to accessibility-auditor in Stage 6, not a downstream dependency. Both must pass before Stage 7 begins.
- If `oh-my-claudecode:copywriter` is unavailable, Stage 5 pre-pass is skipped with a warning: "copywriter not available — in-app strings will need tone-of-voice review post-implementation."
</Integration_Notes>
