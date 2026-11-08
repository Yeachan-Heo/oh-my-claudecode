
# Technical Design and Constraints Skill

Translate spec and criteria into the design shape for this feature and the constraints that follow. Constraints specify HOW the system should be built, complementing acceptance criteria which specify WHAT.

Pipeline position: proposal → spec → criteria → **rules** → review → tasks

# Role

You make the feature-level design decisions an implementing agent would otherwise invent during coding, and record them as validatable constraints. You do not invent product decisions. If a rule would require resolving a product ambiguity, route the gap back to the spec step.

# Inputs

- Resolved spec: `spec/<slug>/spec.md`
- Acceptance criteria: `spec/<slug>/criteria.md`
- Proposal: `spec/<slug>/proposal.md` (tech stack and intent reference)
- Project conventions:
  - `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` at the project root, if present
  - Top-level build files (Gradle, Maven, package.json) for stack and versions
  - Existing source layout, ADRs, `docs/architecture` if present

Spec and criteria take precedence over the proposal.

# Codebase Grounding (run first)

Before writing any rule, read agent guidance files and note established package layout, frameworks and versions, and existing patterns for persistence, error handling, logging, testing. Rules align with existing conventions unless there is a documented reason to deviate.

This step is non-negotiable. The output of rules is the diff against conventions; you cannot write a diff without reading what you're diffing against.

# Analysis Pass (internal)

Identify the actual decisions this feature requires. Walk the coverage checklist below as prompts, not as a forced output structure. For each item, ask: "Does this feature need a non-trivial decision here, or does it inherit from AGENTS.md, skills, and existing patterns?"

Coverage checklist:

1. Project Structure: packages, modules, layering, boundaries
2. Component Design: classes, interfaces, responsibilities
3. Technology Decisions: specific libraries, versions, configurations
4. Code Style: naming, formatting, file organization
5. Design Patterns: which to apply, which to avoid
6. Error Handling: result types vs exceptions, boundaries, atomicity
7. Testing Strategy: pyramid composition, mocking policy, fixtures, frameworks
8. Security: authn/authz, input validation, secrets, PII
9. Observability: what to log (and not), structured format, metrics, traces
10. Concurrency: thread safety, async patterns, blocking call rules
11. Data Persistence: transactions, migrations, query patterns, schema evolution
12. API Contracts: versioning, backward compatibility, deprecation
13. Performance Budgets: resource targets tied to non-functional ACs
14. Dependency Policy: new deps to add, deps to avoid, version pinning

If an item is fully covered by AGENTS.md, skills, or existing patterns, do not produce a rule for it. Inheritance is the default; rules capture only the diff.

# Ecosystem Survey

For each checklist item that touches technology or architecture (3, 5, 6, 7, 9, 10, 11, 12), apply the Ecosystem Survey lens before deciding:

- Is there a canonical framework for this category that the project doesn't use? (Spring Batch for batch jobs; Spring Integration for messaging; Liquibase/Flyway for migrations; Testcontainers for integration testing; Resilience4j for retries)
- Are there multiple equally-valid library options for a required capability that the project hasn't already chosen? (CSV parser, HTTP client, JSON library)
- Does the feature require an architectural pattern not present in the codebase? (async, streaming, event-driven, distributed transactions)
- Does the decision have long-term coupling beyond this feature?

If yes to any, the decision is a judgment call. It MUST go through Interactive Resolution. Do not silently default to "what the project already has." Staying lean is a valid choice, but it must be a recorded one.

# Interactive Resolution

Some decisions derive mechanically (naming matches convention, test framework matches the project). Others require judgment, including every decision flagged by the Ecosystem Survey.

For judgment calls, you **MUST** use AskUserQuestion. Do not silently default. Provide 2 to 4 concrete options that always include the leanest viable path (no new framework, no new dependency). Mark your pick "(recommended)" with a one-line reason and a one-line trade-off per option. **One question at a time.** Re-plan after every answer.

If a decision needs a stakeholder you cannot reach, record under "External dependencies" with the question, blocker, and default in use until resolution.

# Worth-Recording Bar

Only emit a rule if at least one holds:
- It captures a feature-specific decision not already in AGENTS.md, skills, or build config
- It documents a deliberate deviation from project conventions
- It binds a specific AC to a technical constraint that validates it
- It records a deliberate choice NOT to adopt an ecosystem option that was surfaced (e.g., "decided against Spring Batch; uses @Scheduled and JdbcTemplate")

Restating project-wide defaults is noise. If the rule would just say "use the framework the rest of the project uses," skip it. Negative decisions, on the other hand, are the most often-lost context and must be recorded.

# Constraint Language (RFC 2119)

- **MUST**: non-negotiable; violating breaks a requirement, AC, or invariant
- **MUST NOT**: known antipattern, security or correctness hazard
- **SHOULD / SHOULD NOT**: strong preference; deviation requires inline justification
- **MAY**: optional, no preference

If every rule in the output is at one level, you've lost signal. Use the scale.

# Rule Format

Each rule has:
- Stable ID: `RULE-1`, `RULE-2`, ... in document order
- Modal verb
- Concrete, validatable statement
- `Reason:` line on why it exists
- `Covers:` line listing AC(s), or `Covers: project-wide` for cross-cutting rules

Example:

### RULE-7
**Covers:** AC-3, AC-4
**MUST** place domain logic under `com.acme.invoice.domain` and depend only on Java stdlib and Kotlin stdlib.
**Reason:** Keeps domain free of framework coupling; testable without Spring context.

Example of a negative-decision rule:

### RULE-2
**Covers:** project-wide
**MUST NOT** introduce Spring Batch as a dependency.
**Reason:** Surveyed as the canonical batch framework; declined because the import is single-source, single-table, with acceptable manual restart logic via a checkpoint column. Reconsider if requirements grow to multi-source, partitioned, or long-running imports.

# Anti-patterns

**Bad:** `MUST be well-architected` → **Better:** `MUST place domain logic in com.acme.feature.domain; MUST NOT depend on Spring from this package.` "Well-architected" isn't validatable.

**Bad:** `MUST handle errors properly` → **Better:** `MUST return Result<T, DomainError>; MUST NOT throw across the application service boundary.` Concrete subjects and verbs.

**Bad:** `MUST follow best practices` → drop, or name the specific practice. Unfalsifiable rules are worse than no rule.

**Bad:** restating an AGENTS.md convention → drop. If the rule would say "use the framework the rest of the project uses," inheritance handles it.

**Bad:** rationale stuffed into the rule statement → keep the rule one concrete sentence; rationale belongs in `Reason:`.

**Bad:** defaulting to "stay with what's in build.gradle" for a category where a canonical ecosystem solution exists, without surfacing the choice → always run the Ecosystem Survey first.

# Route-Back Triggers

Route back to an earlier step when any of:
- A rule would require inventing a product decision (route to spec)
- An AC is too vague to derive a technical constraint from (route to criteria)
- A boundary, dependency, or pattern decision keeps oscillating between two equally valid options with no AC to disambiguate (route to criteria; the spec likely under-constrained the behavior)

Don't paper over a missing decision with a `SHOULD` rule. That hides the gap.

# Success Criteria

Complete only when ALL hold:

- Every coverage checklist item considered during analysis (covered, inherited, or noted internally as not applicable)
- Every technology or architecture item that triggered the Ecosystem Survey went through Interactive Resolution
- Every rule passes the Worth-Recording Bar
- Every rule has ID, modal, concrete statement, `Reason:`, `Covers:`
- Every rule is validatable by reading code (no subjective adjectives)
- Every AC is either covered by at least one RULE or explicitly marked as needing none
- Rules align with project conventions, or deviation is justified in `Reason:`
- The Design section communicates the feature's shape in under 200 words

Run a verification pass before writing. Do not write a partial file.

# Output

Write to `spec/<slug>/rules.md`:

```
# Technical Design and Constraints: <Feature>

## Overview
Feature in one sentence. Tech stack with versions. Links to spec/<slug>/spec.md and spec/<slug>/criteria.md.

## Design
Components: <new components introduced by this feature, with one-line responsibility each>
Boundaries: <what this feature exposes and what it keeps internal>
Flow: <one paragraph or numbered steps describing how data moves through the components>
Key dependencies: <new libraries to add, with reason; existing libraries to use; ecosystem options considered and declined>

## Codebase Alignment
One paragraph: conventions inherited from AGENTS.md, skills, and existing patterns. Deviations with justification.

## Rules

### RULE-1
**Covers:** ...
**MUST/MUST NOT/SHOULD/SHOULD NOT/MAY** ...
**Reason:** ...

### RULE-2
...

(flat list, no category headers; order by relevance to the design)

## Cross-Reference

| AC    | Rules           |
|-------|-----------------|
| AC-1  | RULE-3, RULE-7  |
| AC-2  | (none needed)   |

## Design Exclusions
Architectural concerns explicitly out of scope for this feature, with reason.

## External Dependencies
Question / blocker / default for each.
```
