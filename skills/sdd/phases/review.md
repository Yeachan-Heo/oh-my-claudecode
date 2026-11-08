
# Spec Review Skill

Stress-test the spec pipeline against itself and the codebase. Surface anything that would cause an implementing agent to fail or build the wrong thing. Trust upstream's self-verification by default; investigate the seams.

Pipeline position: proposal → spec → criteria → rules → **review** → tasks

# Role

You produce a report and, when needed, a Fix Plan that sequences the user's resolution work. You do not fix issues yourself. You do not ask the user questions. If findings need resolution, the user reruns the relevant upstream skill in the order the Fix Plan prescribes.

# Operating Principle

Each upstream step has its own Success Criteria and verification pass. Do not re-derive what upstream already verified within its own artifact. Review's job is the cross-document and cross-codebase layer that no single step can see:

- The chain from behaviors to criteria to rules holds end-to-end
- The composed design is consistent with itself and with the codebase
- The risks specific to this feature, even with a passing spec, are surfaced
- Any fixes are sequenced so the user can resolve them in pipeline order

If you find yourself rebuilding a coverage table or re-deriving a forward trace, you are doing upstream's work. Verify the existing structures instead.

# Pipeline Contract

FAIL blocks the plan step. PASS WITH CONDITIONS requires fixes via the relevant upstream skill before plan runs. The Fix Plan sequences the work; the user follows it top to bottom and reruns review once at the end.

# Inputs

- Proposal: `spec/<slug>/proposal.md`
- Spec: `spec/<slug>/spec.md`
- Criteria: `spec/<slug>/criteria.md`
- Rules: `spec/<slug>/rules.md`
- Project conventions: `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, build files, source layout, test setup

# Codebase Grounding (run first)

Before checking anything else, ground the review in the actual project state:

- Read the build file. Confirm declared libraries exist at the declared versions; confirm new libraries proposed in rules.md can actually be added (presence in the registry, no obvious license conflicts).
- Read the source layout. Confirm the package locations rules.md prescribes match the project structure or are creatable without breaking it.
- Read existing patterns for persistence, error handling, logging, testing. Confirm the Design section and rules align, or that deviations are justified in rules' `Reason:` lines.
- Read the test setup. Confirm the proposed test strategy is achievable with the project's existing test infrastructure.

This grounding feeds the Codebase Grounding category later. Without it, that category can only check claims, not reality.

# Severity

- **BLOCKER**: implementation cannot proceed (broken trace chain, AC contradicted by a rule, declared library missing, codebase incompatible with a rule)
- **MAJOR**: implementation will produce wrong behavior or significant rework (unmeasurable non-functional threshold, missing test approach for an EARS pattern present in criteria, scope item reintroduced)
- **MINOR**: clarity or consistency issues that don't change the result (naming inconsistency, redundant rule, stale reference)

If uncertain BLOCKER vs MAJOR, treat as BLOCKER. If MAJOR vs MINOR, treat as MAJOR.

# Verdict

- **PASS**: zero blockers, zero majors (no Fix Plan)
- **PASS WITH CONDITIONS**: zero blockers, one or more majors (Fix Plan required)
- **FAIL**: one or more blockers (Fix Plan required)

Minors don't affect the verdict and don't appear in the Fix Plan.

# Review Categories

Run all five. Record findings inline per category, or confirm pass.

## 1. Discipline Check (thin verification)

Sample upstream's claimed structure; do not rebuild it.

- Every `Covers: B-N` reference in criteria.md points to a real B-N in spec.md
- Every `Covers: AC-N` reference in rules.md points to a real AC in criteria.md
- Every B-N in spec.md appears in at least one AC's `Covers:` line (no orphan behaviors)
- Every AC appears in rules.md Cross-Reference table or is explicitly marked "(none needed)" (no orphan criteria)
- The Cross-Reference table in rules.md is accurate: spot-check 3 entries against the actual rule contents
- Every AC matches one of the five EARS templates (or the Combined variant); no template-free criteria

This category is fast. If it produces more than a handful of findings, upstream skipped its own verification pass and should be rerun before continuing review.

## 2. Cross-Document Conflicts

The centerpiece. No upstream step can detect these.

- **AC ↔ AC**: two ACs that cannot both hold
- **AC ↔ RULE**: a rule that prevents an AC's outcome
- **RULE ↔ RULE**: two rules that cannot both hold
- **Design ↔ Rules**: a rule that contradicts the Design section in rules.md (e.g., Design says "synchronous flow," a rule introduces async messaging)
- **Scope reintroduction**: anything in `Out of scope` (spec), `Coverage exclusions` (criteria), or `Design exclusions` (rules) that resurfaces elsewhere in the pipeline
- **Negative-decision violations**: any rule that proposes adopting an ecosystem option that another rule explicitly declined (e.g., a rule references Spring Batch APIs when another rule declined Spring Batch)

For each conflict, quote both sources verbatim. Conflicts are nearly always at least MAJOR; often BLOCKER.

## 3. Codebase Grounding

Use the grounding pass above to verify the composed design holds against reality.

- Every library named in rules.md exists in the project or can be added (registry presence, version compatibility)
- Every package and module path the design uses exists or is creatable without breaking existing structure
- Every pattern the rules invoke (transactional boundaries, error handling shape, persistence approach, observability hooks) is achievable with the declared frameworks at their declared versions
- The proposed test setup is compatible with existing test infrastructure (framework, runner, container support, fixture conventions)
- Anything in the Design section that implies a code structure has a viable place to land in the current layout

Findings here are usually BLOCKER (incompatible library, missing capability) or MAJOR (achievable but with non-trivial work not yet specified).

## 4. EARS Template ↔ Test Strategy Fit

For each EARS pattern present in criteria.md, confirm rules.md's testing strategy can validate it.

- **Ubiquitous** (`The system shall ...`): invariant or continuous-state test
- **Event-driven** (`When X, the system shall ...`): event-simulation test
- **State-driven** (`While X, the system shall ...`): state-setup test
- **Unwanted behavior** (`If X, then the system shall ...`): negative-path test that asserts the prohibited outcome is absent
- **Combined** (`While X, when Y, ...`): both state and event setup
- **Boundary patterns** (within / at / beyond): three-point coverage
- **Negative criteria** (authz, side-effect paths): explicit assertions on the "and not" half

If the rules' testing strategy doesn't cover one of these patterns that criteria uses, it's a MAJOR finding. The implementing agent will write tests anyway, but without guidance the test shape may not match the AC shape.

## 5. Risk Hotspots (required)

Up to five areas most likely to go wrong even with a passing spec. For each: area / reason / mitigation.

If you cannot identify any, write `Hotspots: none considered material` with a one-line justification. Empty is acceptable; absent is not.

This is the section most likely to be useful to the implementing agent. It's the only output review produces that upstream cannot.

# Finding Format

Each finding has:
- Stable ID: `BLOCKER-1`, `MAJOR-1`, `MINOR-1` (numbered per severity)
- Title
- Source document(s)
- Issue with exact problematic text quoted
- Impact: what goes wrong if not fixed
- Resolution: which upstream skill to rerun, and on what
- Optional `Related:` for clusters

# Fix Plan Format

Produce a Fix Plan when the verdict is PASS WITH CONDITIONS or FAIL. Omit for PASS. Minors do not appear in the Fix Plan.

Structure:

- One header line naming the execution order through the pipeline, e.g. `Execution order: spec → criteria → rules → review`. Include only steps that have fixes; always end with `review`.
- One subsection per upstream step that has fixes, in pipeline order (spec, then criteria, then rules).
- Within each subsection, a numbered list of fixes. Each fix has:
    - A `[cascades]` or `[localized]` tag
    - The finding ID this fix resolves (`BLOCKER-N`, `MAJOR-N`)
    - A concrete instruction on what to change
    - For cascading fixes: a one-line note on what will need to be rerun downstream

A fix **cascades** if any of:
- It adds, removes, or changes a B-N in spec.md
- It changes an assumption, edge case, or scope item that has downstream coverage
- It changes the EARS pattern of an AC, or removes or adds an AC that has covering rules
- It changes the Design section, an Ecosystem Survey decision, or a rule that other rules depend on

A fix is **localized** if it stays inside a single section of a single document and produces no change to any structure that downstream depends on. Typical localized fixes: naming cleanup, stale references, rationale clarification, removing redundant rules with no downstream `Covers:` references.

If uncertain, mark `[cascades]`. False cascades cost one unnecessary rerun; false localized marks corrupt the chain.

The plan ends with `### review` indicating when to rerun this skill (once all upstream fixes are in, not per-fix).

# Success Criteria

Complete only when ALL hold:

- Codebase grounding pass executed before any category
- All five categories run; each either confirms pass or lists findings
- Risk Hotspots populated (or explicitly empty with reason)
- Every finding has all required fields
- Every quoted text matches the upstream file verbatim
- Verdict matches severity counts
- Fix Plan present for non-PASS verdicts: groups by step, orders by pipeline position, marks every fix `[cascades]` or `[localized]`, ends with `### review`

Do not write a partial file.

# Output

Write to `spec/<slug>/review.md`. For a clean spec, this should be a short document. Bloat is a smell.

```
# Spec Review: <Feature>

## Summary
- Feature: <name>
- Verdict: <PASS | PASS WITH CONDITIONS | FAIL>
- Counts: <N blockers, N majors, N minors>
- Action: <one line; references Fix Plan for non-PASS verdicts>

## Discipline Check
<one paragraph: confirmed clean, or list of findings>

## Conflicts
<empty if none; otherwise findings with both sources quoted>

## Codebase Grounding
<one paragraph: design fits codebase, or list of findings>

## EARS ↔ Test Strategy
<one paragraph: each pattern has a fitting test approach, or list of findings>

## Risk Hotspots
<up to five: area / reason / mitigation; or "none considered material" with reason>

## Fix Plan
For PASS WITH CONDITIONS or FAIL only; omit entirely for PASS.

Execution order: <pipeline steps with fixes, in order, ending with review>

### <step> (rerun <position>)
1. [cascades|localized] <FINDING-ID>: <what to change>
   <if cascades: one line on what needs rerunning downstream>

### review
Rerun once all upstream fixes are in.
```
