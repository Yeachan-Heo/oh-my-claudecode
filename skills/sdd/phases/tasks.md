
# Taslk List Generator Skill

Translate a validated spec into an ordered, atomic, AC-traceable execution list an implementing agent can run task by task.

Pipeline position: proposal → spec → criteria → rules → review → **tasks** -> execute

# Role

You translate a validated spec into a task list written to disk. You do not write code, run tests, or modify project files outside `spec/<slug>/tasks.yaml`. You do not ask questions; document judgment calls in `decisions` for the user to review.

# Pipeline Contract

Read `spec/<slug>/review.md` (if exists) first. Locate the verdict line under `## Summary`.

- **FAIL**: refuse. Print the blocker IDs and recommend rerunning the relevant upstream skill. Do not write `spec/<slug>/tasks.yaml`.
- **PASS WITH CONDITIONS**: each major must be reflected in the task list, either as a dedicated task with `source: review/MAJOR-N` or a `risk` annotation on an existing task. Note in `assumptions`.
- **PASS**: proceed.

Risk Hotspots from the review surface as `risk` annotations on the relevant task, regardless of verdict.

# Inputs

- Proposal: `spec/<slug>/proposal.md`
- Spec: `spec/<slug>/spec.md`
- Rules: `spec/<slug>/rules.md` (optional)
- Review: `spec/<slug>/review.md` (optional, pipeline gate)
- Project conventions: `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, build files, source tree

Spec takes precedence over the proposal.

# Codebase Grounding (run first)

Read agent guidance files. Note package layout, module boundaries, naming, build/test/deployment patterns, and architectural style (layered, hexagonal, feature-sliced). Tasks place artifacts in paths consistent with the existing structure. Phases respect the existing architectural style unless `rules.md` mandates a deviation.

# Phase Organization

Pick an organizing principle and state it in `organizing_principle`:

- **walking_skeleton**: thin end-to-end slice first, then thicken. Default. Best when integration risk dominates.
- **layered**: data → domain → application → presentation. Best for layered architectures.
- **feature_slice**: one phase per AC cluster, each shippable. Best for feature-sliced or hexagonal projects.
- **risk_first**: highest-risk decisions first. Best when Risk Hotspots are non-trivial.

State the choice and one-line reason in `decisions`.

# Task Granularity

- Completable in a single focused effort (rule of thumb: under an hour)
- Produces a verifiable artifact (file, passing test, documented decision)
- Small enough to roll back cleanly
- References ACs and RULES it covers via `covers`

# Dependency Rules

- No circular dependencies
- Minimize cross-phase dependencies
- Infrastructure before business logic; interfaces before implementations; fixtures before tests

# Checkpoint Patterns

Place checkpoints where human review meaningfully reduces risk:
- After project structure or scaffolding
- After the first end-to-end slice runs
- After core domain logic is in place
- After each major integration boundary
- After test suite green for a phase's ACs
- Before any irreversible step (migrations, deletions, API contract changes)

Every phase ends with a checkpoint. Intermediate checkpoints allowed within a phase.

# Stable IDs

- Phases: `phase-1`, `phase-2`, ... in execution order
- Tasks: `task-N.M` (phase number, task number)
- Checkpoints: `cp-N` (terminal) or `cp-N.M` (intermediate)
- Decisions: `dec-1`, `dec-2`, ...

# Soft Limits

Aim for ≤ 5 phases, ≤ 7 tasks per phase. If you exceed:
- The feature is probably too large. Recommend a split in `decisions` rather than padding.
- If a split isn't sensible, exceed the limit and note the reason in `decisions`.

Don't pad or merge to fit the numbers.

# Coverage

Every AC in `criteria.md` appears in some task's `covers.acs`, OR in `coverage_deferrals` with a reason. No third option.

# Output Schema

```yaml
tasks:
  feature: "<name>"
  review_verdict: "<PASS | PASS WITH CONDITIONS>"
  organizing_principle: "walking_skeleton | layered | feature_slice | risk_first"
  assumptions:
    - "<assumption to verify>"
  decisions:
    - id: dec-1
      decision: "<judgment call>"
      reason: "<why>"
      alternatives: ["<alt 1>", "<alt 2>"]
  coverage_deferrals:
    - ac: AC-12
      reason: "<why not in a task>"
  phases:
    - id: phase-1
      name: "<phase name>"
      description: "<what this accomplishes>"
      covers: [AC-1, AC-2]
      entry_criteria: "<what must be true to start>"
      tasks:
        - id: task-1.1
          name: "<task name>"
          description: "<what to do>"
          artifact: "<file path or outcome>"
          covers:
            acs: [AC-1]
            rules: [RULE-3, RULE-7]
          depends_on: []
          complexity: "S | M | L"
          validation: "<how to verify>"
          risk: "<from Risk Hotspots, if applicable>"
          source: "<review/MAJOR-N if addressing a review finding>"
      checkpoint:
        id: cp-1
        description: "<what to review>"
        criteria:
          - "<criterion 1>"
```

**Required**: top-level `feature`, `review_verdict`, `organizing_principle`, `phases`; phase `id`, `name`, `description`, `covers`, `tasks`, `checkpoint`; task `id`, `name`, `description`, `artifact`, `covers`, `depends_on`, `validation`; checkpoint `id`, `description`, `criteria`.

**Optional**: `assumptions`, `decisions`, `coverage_deferrals`, `entry_criteria`, `complexity`, `risk`, `source`.

# Success Criteria

Complete only when ALL hold:

- Pipeline contract honored: FAIL refused; PASS WITH CONDITIONS reflected in tasks or risks
- Every AC in `criteria.md` in some task's `covers.acs` or in `coverage_deferrals`
- Every task has required fields
- Every `depends_on` references an earlier task in execution order
- No circular dependencies
- Every phase ends with a checkpoint
- `organizing_principle` set and justified in `decisions`
- All Risk Hotspots reflected in task `risk` annotations
- Soft limits met, or deviation justified in `decisions`

Verification pass before writing:
- Walk phases in order; every `depends_on` points to a task that has appeared
- AC IDs in `covers.acs` (across all tasks) equals AC IDs in `criteria.md` minus `coverage_deferrals`
- Every RULE ID in `covers.rules` is real in `rules.md`
- `feature`, `review_verdict`, `organizing_principle`, every phase checkpoint present

Do not write a partial file.

# Output

Write to `spec/<slug>/tasks.yaml`.
