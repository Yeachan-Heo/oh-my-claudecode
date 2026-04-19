---
name: pre-launch-sprint
description: 4-week pre-launch deepening sprint for a single core feature — Mechanic definition → Build with property tests → External validation via design partners → Harden → Launch-readiness gate; scales depth by feature class (core/enabling/context)
argument-hint: "<feature-slug>"
level: 4
---

# Pre-Launch Sprint Skill

Orchestrates a 4-week deepening sprint for a single pre-launch feature, with depth scaled by feature class. Drives mechanic rigor, experience polish, and external validation before launch — the pre-launch counterpart to post-launch improvement-sprint (which doesn't exist yet because there are no metrics to drive it before ship). Culminates in a launch-readiness gate that says GO / HOLD / one-more-cycle.

## Usage

```
/oh-my-claudecode:pre-launch-sprint <feature-slug>
/pre-launch-sprint <feature-slug>
/pre-launch-sprint <feature-slug> --class=core             # default: auto-detect from .omc/classification/
/pre-launch-sprint <feature-slug> --week=3                 # resume from specific week
/pre-launch-sprint <feature-slug> --launch-gate            # run only Phase 5 (readiness check)
```

### Examples

```
/pre-launch-sprint matching-algorithm
/pre-launch-sprint onboarding-flow --class=core
/pre-launch-sprint settings-page --class=context           # minimal depth, proven-pattern mode
/pre-launch-sprint matching-algorithm --week=3             # resume week 3 after pause
/pre-launch-sprint matching-algorithm --launch-gate        # only readiness gate
```

### Flags

- `--class=core|enabling|context` — depth modifier (auto-detected from `.omc/classification/features-core-context.md` if present).
- `--week=<1-4>` — resume from a specific week; skips prior weeks if their handoffs exist.
- `--launch-gate` — run Phase 5 only (standalone readiness check).
- `--skip-external` — skip Week 3 design-partner validation (NOT recommended for core; silently ignored if class=core).
- `--domain=<list>` — hint for domain-expert-reviewer persona selection (healthcare, financial, etc.).
- `--partners=<count>` — override minimum design-partner count for Week 3 (default: 5 for core, 3 for enabling, 0 for context).

<Purpose>
A single command that takes one pre-launch feature through the full mechanic → experience → validation → hardening cycle before launch. Enforces non-skippable depth phases for core features and light-touch passes for context features. Culminates in a launch-readiness gate that produces a GO / HOLD / one-more-cycle recommendation with evidence. Stops at HARD STOPs (class misclassified, required partners absent for core, external-validation critical findings) with explicit remediation.
</Purpose>

<Use_When>
- Feature has passed product-strategist + priority-engine and is in active pre-launch build.
- Feature is class=core or class=enabling (context features don't need this pipeline).
- No real users exist yet (pre-launch posture); signal comes from design partners, prototypes, and expert proxies.
- Team wants a structured, non-skippable deepening pass before committing to launch.
- User invokes `/pre-launch-sprint` directly.
</Use_When>

<Do_Not_Use_When>
- Feature is already live and has metrics — use post-launch improvement loop (scientist + quality-audit + priority-engine).
- Feature is class=context (auth, settings, billing) with a proven-pattern implementation — run executor directly.
- Feature is still in ideation/strategy — run `/oh-my-claudecode:ideate` first, then `/oh-my-claudecode:product-pipeline` or `/oh-my-claudecode:backend-pipeline`, then this sprint.
- You need to deepen multiple features in parallel — run this skill once per feature; parallel deepening creates coordination cost without benefit.
- No design-partner program exists and class=core — run `/oh-my-claudecode:design-partner-manager --init` first.
</Do_Not_Use_When>

<Why_This_Exists>
Post-launch improvement is metrics-driven: measure → diagnose → improve. Pre-launch has no metrics, so teams default to one of two failure modes: (a) ship without depth and discover known-class problems post-launch at 10–100× cost, (b) deepen indefinitely without a discipline for when to stop ("polishing forever" — the runway killer).

This skill encodes a structured pre-launch depth protocol: 4 weeks per core feature, with each week producing a specific deliverable that the next week depends on. Week 1 pins the mechanic; Week 2 builds with property-based tests; Week 3 validates externally via design partners and expert proxies; Week 4 hardens known gaps; then a launch-gate says GO or one-more-cycle.

It also enforces the core-vs-context discipline: context features get a minimal 1–2 day pass instead of 4 weeks, because spending craftsman depth on commodity features is the most common waste of pre-launch runway. The skill auto-scales by class.

Additionally, it keeps mechanic divergence (ideate within a feature's scope) as a sanctioned Week 1 activity, resolving the earlier tension: ideate is not for every shipped feature (post-launch creates migration cost), but IS valid for pre-launch mechanic refinement (no migration cost, high leverage).
</Why_This_Exists>

<Pipeline_Phases>

## Phase 0 — Foundation and Classification

**Agent:** product-strategist (if class not explicit)
**Input:** Feature slug + `.omc/constitution.md` + `.omc/classification/features-core-context.md` (if exists)
**Output:** Confirmed class + feature scope artifact at `.omc/sprints/<slug>/00-foundation.md`

**Protocol:**
1. If `--class` flag present, use it.
2. Else if `.omc/classification/features-core-context.md` contains an entry for this slug, use that.
3. Else invoke `oh-my-claudecode:product-strategist` with directive: "Classify <slug> as core / enabling / context per constitution. Cite mission and anti-goals. Flag if classification is unclear."
4. Verify constitution status. If absent/draft AND class=core → warn strongly; deepening against a missing foundation produces brittle findings.
5. Write Foundation artifact noting class, depth mode, and sprint duration:
   - core → 4 weeks, all phases mandatory
   - enabling → ~1 week, Weeks 1 & 2 condensed, Week 3 light, Week 4 skipped
   - context → 1–2 days, Week 2 only with proven patterns, no deepening

**HARD STOP:** Classification is genuinely ambiguous AND no user override. Report: "Classification is load-bearing — cannot run sprint without class. Resolve via product-strategist with evidence or pass `--class=` explicitly."

---

## Phase 1 — Week 1: Mechanic Definition (core / enabling only)

**Agents:** ideate (scoped) → architect → critic (premortem) → analyst
**Input:** Foundation artifact + feature description
**Output:** `.omc/sprints/<slug>/week1-mechanic.md`

**Protocol:**
1. **Divergent mechanic exploration** (core only):
   - Invoke `/oh-my-claudecode:ideate --scope=feature:<slug> --methods=first-principles,triz,morphological`
   - Read `.omc/ideas/YYYY-MM-DD-<slug>.md` shortlist — select one alternative mechanic.
   - Enabling features skip this step; they take the existing mechanic as given.
2. **Architectural options**: Invoke `oh-my-claudecode:architect` with directive: "Propose ≥2 implementation options for <chosen mechanic> with reversibility class (Type-1/Type-2) and trade-offs."
3. **Premortem**: Invoke `oh-my-claudecode:critic` with directive: "Premortem the chosen implementation option. Assume it fails in production — most plausible failure story? Cite specific failure mechanisms."
4. **Acceptance criteria and invariants**: Invoke `oh-my-claudecode:analyst` with directive: "Produce testable acceptance criteria and mechanical invariants (properties that must hold across all inputs, e.g., idempotency, monotonicity, commutativity, bounds). Mark each invariant as a property-testable predicate."
5. Consolidate into Week 1 artifact with: chosen mechanic, chosen implementation, failure modes, invariants, acceptance criteria.

**HARD STOP:** critic premortem finds a CRITICAL failure mode with no proposed mitigation → loop back to architect for redesign; do not advance.

**HARD STOP:** analyst cannot produce testable invariants (the mechanic is too loosely specified). Back to analyst with specific directive to formalize.

---

## Phase 2 — Week 2: Build with Property-Based Tests

**Agents:** pipeline (backend-pipeline or product-pipeline) + test-engineer (property-based focus)
**Input:** Week 1 artifact
**Output:** `.omc/sprints/<slug>/week2-build.md` + implemented code + property-based test suite

**Protocol:**
1. Route to the correct pipeline based on feature type:
   - Backend mechanic (engine, API, job, migration) → `/oh-my-claudecode:backend-pipeline`
   - User-facing with UX surface → `/oh-my-claudecode:product-pipeline`
   - Both → backend-pipeline first for contract, product-pipeline second
2. Within the pipeline, Stage 6 (implementation) uses the Week 1 invariants as property-test inputs. Inject directive to test-engineer: "For each invariant from Week 1, implement a property-based test (Hypothesis / fast-check / PropTest / ScalaCheck per language). Run at least 10 000 iterations per property. Report failures with minimized counterexamples."
3. Example-based tests cover acceptance criteria; property-based tests cover invariants. Both required for core.
4. Include at least one failure-mode test (injected exception, partial write, network partition) for backend mechanics.
5. Do NOT ship to staging without Stage 7 (Quality Bar) passing.

**HARD STOP:** Property tests fail and the failure cannot be fixed within the week without changing the mechanic. Back to Phase 1 with the failing counterexample as a new invariant to resolve.

---

## Phase 3 — Week 3: External Validation (core MUST; enabling SHOULD)

**Agents:** design-partner-manager (feedback cycle) + domain-expert-reviewer (proxy) + ux-researcher (synthesis) + critic (second premortem)
**Input:** Deployed-to-staging feature + Week 1 & 2 artifacts
**Output:** `.omc/sprints/<slug>/week3-validation.md` + updated `.omc/research/` + `.omc/expert-review/`

**Protocol:**
1. **Design-partner feedback cycle** (core: ≥5 partners; enabling: ≥3):
   - Invoke `/oh-my-claudecode:design-partner-manager --session <slug>` — schedules structured sessions with existing partners.
   - Collect session notes in `.omc/partners/sessions/`.
   - Invoke `/oh-my-claudecode:design-partner-manager --synthesize --since=<sprint-start>` — ux-researcher synthesizes into `.omc/research/`.
2. **Domain-expert proxy review** (core: mandatory for regulated domains; enabling: optional):
   - Invoke `oh-my-claudecode:domain-expert-reviewer` with feature scope and `--domain=<list>` if known.
   - Review lands in `.omc/expert-review/`.
3. **Prototype / Wizard of Oz** (when the mechanic is non-deterministic or user-dependent):
   - Run structured prototype test (Maze / UserTesting / corridor) or manual WoZ with ≥3 sessions.
   - Record completion rate, task-success, and verbatim quotes.
4. **Second premortem** (post-evidence):
   - Invoke `oh-my-claudecode:critic` with directive: "Given the design-partner findings, expert-review findings, and prototype results, produce a second premortem. Update failure modes from Week 1."
5. Consolidate into Week 3 artifact with convergent findings, unique findings, conflicts, and updated failure modes.

**HARD STOP:** Design-partner count below minimum for class. Report: "Core features require ≥5 design partners before launch validation. Run `/oh-my-claudecode:design-partner-manager --recruit` to reach minimum."

**HARD STOP:** Domain-expert-reviewer returns DO-NOT-LAUNCH-WITHOUT-REMEDIATION. Halt; resolve before Week 4.

**HARD STOP:** Convergent CRITICAL finding across partners and expert-review. Back to Phase 1 with finding as new invariant.

**Proceed:** Partners surfaced only MINOR issues or a clear set of MAJOR issues with remediation paths. Expert-proxy recommendation is GO or HOLD with remediation.

---

## Phase 4 — Week 4: Harden (core only; enabling skips)

**Agents:** critic (narrow red-team) + ideate (narrow, only if Phase 3 revealed fundamental gap) + performance-guardian (backend-budget for core backend) + security-reviewer (--security-depth=deep) + trace
**Input:** Week 3 artifact + Phase 3 findings
**Output:** `.omc/sprints/<slug>/week4-harden.md` + patches

**Protocol:**
1. **For every MAJOR/CRITICAL finding from Week 3**:
   - If implementable within a day → executor with narrow directive.
   - If requires redesign → ideate narrow + architect pass, loop back to Phase 2 for a tight rebuild.
2. **Performance pass** (backend mechanics):
   - Invoke `oh-my-claudecode:performance-guardian` in backend-budget mode per `skills/backend-pipeline` Stage 7 protocol.
3. **Security deep pass**:
   - Invoke `oh-my-claudecode:security-reviewer` with `--security-depth=deep`. Threat model + abuse cases for this feature.
4. **Trace hidden dependencies**:
   - Invoke `/oh-my-claudecode:trace` on the feature to surface connections architect did not see in Week 1 static analysis.
5. **Accessibility pass** (if user-facing): accessibility-auditor if available, WCAG 2.1 AA minimum.
6. Consolidate Week 4 artifact with: remaining open items, each tagged ACCEPTED-RISK / MUST-FIX-BEFORE-LAUNCH / POST-LAUNCH-TODO.

**HARD STOP:** MUST-FIX-BEFORE-LAUNCH items remain after Week 4. Pipeline halts; team extends sprint by one cycle targeting only those items OR rejects the feature.

---

## Phase 5 — Launch-Readiness Gate

**Agents:** critic (final premortem) + verifier + code-reviewer (opus) + domain-expert-reviewer (final proxy pass, if regulated)
**Input:** All prior sprint artifacts
**Output:** `.omc/sprints/<slug>/05-launch-gate.md` with GO / HOLD / ONE-MORE-CYCLE verdict

**Protocol:**
1. **Final premortem** (`critic`): "Assume this launch fails post-release. Given all sprint artifacts and remaining ACCEPTED-RISK items, what is the most plausible failure story?"
2. **Verifier pass**: every acceptance criterion from Week 1 maps to a passing test.
3. **Code-reviewer pass** (opus, mandatory): multi-perspective on the diff.
4. **Final expert-proxy pass** for regulated domains: `domain-expert-reviewer` runs once more with focus on residual risk.
5. Gate verdict logic:
   - All CRITICAL resolved + zero MUST-FIX-BEFORE-LAUNCH + critic premortem has no novel catastrophic scenarios → **GO**
   - ACCEPTED-RISK items are plausible but not launch-blocking → **GO with risk register** (record in artifact)
   - critic finds novel CRITICAL scenario → **HOLD** + loop to Phase 4
   - Design-partner signal was weak (count below minimum, high heterogeneity, low task-completion) → **ONE-MORE-CYCLE** — extend validation

Verdict + evidence + pre-registered post-launch metrics (success thresholds to measure after launch) written to gate artifact.

**HARD STOP:** Verifier or code-reviewer REJECTED. Back to Phase 4 with specific items.

</Pipeline_Phases>

<Execution_Policy>
- Class modifier is load-bearing: core runs all phases, enabling runs 1 & 2 condensed + light 3, context runs only a minimal Phase 2.
- Weeks are nominal targets; a "week" is a work unit, not a calendar week. A core sprint can compress to 2–3 calendar weeks with focus or expand to 6.
- HARD STOPs halt with the reason and the required remediation path. Never advance past a HARD STOP with a workaround.
- Each phase writes a dated artifact under `.omc/sprints/<slug>/` enabling resumption.
- Composable with `/oh-my-claudecode:ralph` for retry-on-transient-failure: `/ralph /pre-launch-sprint <slug>`.
- Composable with `/oh-my-claudecode:autopilot` for Phase 2 implementation once Week 1 is locked.
- Respects `OMC_SKIP_HOOKS`.
- Multi-feature parallelism is explicitly NOT supported — parallel sprints create coordination overhead with no benefit. Serialize.
</Execution_Policy>

<Input_Contract>
Primary argument: the feature slug (kebab-case).

```
/pre-launch-sprint matching-algorithm
```

The slug must correspond to a feature already known to the product — either in `.omc/roadmap/`, `.omc/plans/`, `.omc/strategy/`, or `.omc/classification/`. Unknown slugs halt Phase 0.

Quality input characteristics:
- Feature is named and scoped.
- Has a prior strategic gate result (APPROVED or APPROVED WITH RISKS).
- Has a prior plan or design partner program in place for class=core.
</Input_Contract>

<Output>
Consolidated sprint folder: `.omc/sprints/<slug>/`

```
.omc/sprints/<slug>/
├── 00-foundation.md           # class, depth mode, duration
├── week1-mechanic.md          # divergence + architecture + premortem + invariants
├── week2-build.md             # pipeline handoff + property tests summary
├── week3-validation.md        # partner + expert + prototype findings
├── week4-harden.md            # findings → fixes map
└── 05-launch-gate.md          # GO / HOLD / ONE-MORE-CYCLE verdict + post-launch metrics
```

Each artifact is self-contained; sprint is resumable from any week.

Final launch-gate artifact schema:

```markdown
# Launch-Readiness Gate: <slug>

**Verdict:** GO | GO with risk register | HOLD | ONE-MORE-CYCLE
**Date:** YYYY-MM-DD
**Feature class:** core | enabling
**Sprint duration:** <weeks>

## Critic final premortem
<novel failure scenarios or "none novel beyond Week 1">

## Verifier verdict
<criterion → test mapping>

## Code-reviewer findings
<CRITICAL/MAJOR/MINOR with evidence>

## Domain-expert final pass (if regulated)
<updated recommendation>

## ACCEPTED-RISK register
<each item: risk, mitigation plan, trigger to revisit>

## Pre-registered post-launch metrics
<metric: threshold: measurement window: kill criterion>

## GO / HOLD / ONE-MORE-CYCLE
<verdict with evidence>
```
</Output>

<Failure_Modes_To_Avoid>
- **Running this sprint on context features.** 4 weeks on auth/settings/billing is misallocated runway. Use proven patterns via executor.
- **Treating weeks as calendar weeks and blocking on time.** Weeks are work units. A week can compress to 3 days with focus or expand. Do not artificially delay to "wait for Week 3."
- **Skipping Week 3 for core features.** Without external validation, depth is speculative. Design partners + expert-proxy are structural, not optional.
- **Using `--skip-external` for core.** Flag is ignored; skill enforces. If the team genuinely has no partners, run `/design-partner-manager --init` before invoking this skill.
- **Deepening indefinitely without a launch-gate.** Phase 5 exists to force a call. A core feature that cannot pass the gate after 2 full cycles signals a strategic problem (wrong feature, wrong market, wrong architecture) — escalate to product-strategist, don't keep polishing.
- **Skipping property-based tests because "we don't do those here".** For core mechanics, property tests find class-level bugs that example-tests cannot. Adoption of Hypothesis / fast-check / PropTest is a one-time cost, not a per-feature one.
- **Parallel sprints on multiple features.** Coordination cost > benefit; serialize.
- **Running Phase 4 hardening without Phase 3 findings to drive it.** Hardening against speculative issues is waste. Let external validation point to what needs hardening.
- **Launch-gate verdict from a single agent.** The gate requires critic + verifier + code-reviewer + (expert-proxy for regulated). One-agent gates hide risk.
- **Ignoring ONE-MORE-CYCLE and shipping anyway.** Skills output a verdict; the team owns the decision, but overriding ONE-MORE-CYCLE should produce a written "accepted risk" entry in the gate artifact, not a silent bypass.
- **Invoking this skill before the feature is strategy-approved.** Deepening a feature product-strategist hasn't approved wastes the sprint. Run strategy-gate first.
- **Assuming partners' silence equals approval.** Partners who don't surface issues in session may have attention or context gaps. Convergent absence across ≥3 partners is signal; single-partner silence is not.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Reads: `.omc/constitution.md`, `.omc/classification/features-core-context.md`, `.omc/roadmap/**`, `.omc/ideas/**`, `.omc/research/**`, `.omc/competitors/**`, `.omc/partners/**`, `.omc/plans/**`.
- Writes: exclusively under `.omc/sprints/<slug>/`; indirectly triggers writes into `.omc/expert-review/`, `.omc/research/`, `.omc/partners/sessions/` via invoked agents.
- Depends on: `oh-my-claudecode:ideate`, `oh-my-claudecode:architect`, `oh-my-claudecode:critic`, `oh-my-claudecode:analyst`, `oh-my-claudecode:backend-pipeline`, `oh-my-claudecode:product-pipeline`, `oh-my-claudecode:design-partner-manager`, `oh-my-claudecode:domain-expert-reviewer`, `oh-my-claudecode:performance-guardian`, `oh-my-claudecode:security-reviewer`, `oh-my-claudecode:verifier`, `oh-my-claudecode:code-reviewer`, `oh-my-claudecode:trace`.
- Depends on `oh-my-claudecode:design-partner-manager` being initialized for class=core.
- Composable with `/oh-my-claudecode:ralph` for retry-on-failure.
- Composable with `/oh-my-claudecode:autopilot` for Phase 2 implementation.
- Post-launch companion (not yet built): `improvement-sprint` — metrics-driven sibling of this skill.
- When `OMC_SKIP_HOOKS` is set, the skill still enforces partner-count minimum for core (structural, not a hook).
- Multi-feature serialization advice: if shipping 3 core features, run 3 sprints in series (12 weeks), not parallel — the discipline and context re-use outweigh schedule pressure.
</Integration_Notes>
