---
name: launch
description: Shipyard's governed delivery pipeline — converge the mission, synthesize a durable spec, decompose vertical-slice tickets with blocking edges, run the frontier in parallel via team, close with verification, and report with a full decision log. Humans own the checkpoints where there is no unique answer or the error cost is severe; agents continuously run everything repeatable and acceptable-by-evidence.
argument-hint: "<mission brief | path to existing spec> [--serial]"
level: 3
pipeline: [deep-interview, launch]
---

# Launch

Launch is the shipyard's delivery run: from mission brief to shipped, verified change. It stands on the verifiability boundary — **agents continuously run everything repeatable and acceptable-by-evidence; humans decide what cannot be judged by the system or what fails expensively.** The goal is not maximum automation — it is maximum delegation of verifiable work, so the human's time is spent only on the decisions only a human can make.

The verifiability test, applied to every step: *if this is done wrong, can the system detect it? Can it redo or roll back automatically?* Both yes → agent. No unique answer, system cannot judge, or expensive to get wrong → human.

Launch assumes the shipyard keel exists (CONTEXT.md, conventions, standards). If the repo has neither `CONTEXT.md` nor a conventions section in `CLAUDE.md`, the paper trail has nowhere to land — recommend running `/oh-my-claudecode:drydock` first (hard dependency; say it explicitly, once).

## The boundary

| Human checkpoints (the critical 20%) | Agent continuous run (the mechanical 80%) |
|---|---|
| C1 author the mission brief (objective + scope) | fact-finding and repo exploration, self-served |
| C2 approve acceptance criteria + test seam list | interview preparation: frontier questions batched with recommended answers |
| C3 approve ticket decomposition (granularity, blocking edges) | spec and ticket drafting, mechanical validation (independence, demonstrability, fits-one-context) |
| C4 answer irreversible decisions that emerge mid-run (batched, async) | tdd implementation at agreed seams, builds, tests, regressions |
| C5 accept the completion report; veto via Open Assumptions | code-review, verify across the change, team frontier scheduling, the whole paper trail |

Between checkpoints the pipeline never idles: agents keep working every frontier ticket that does not depend on a pending human answer.

## Lifecycle posture

Launch is a **stateless composition over OMC's existing lifecycle** — it owns no runtime state machine:

- Team owns task statuses, transitions, cancellation, and runtime cleanup; Launch never mutates them outside Team's contract.
- The canonical `plan` → `execute` → `review` → `verify` surfaces own their existing lifecycle behavior. Launch-authored artifacts are limited to `.omc/specs/<feature-slug>/`, `CONTEXT.md`, `docs/adr/`, and `docs/business/`.
- "Resume" after an interruption is allowed only at a batch boundary: re-read the artifacts and current Team status, then dispatch pending tasks whose numeric `blockedBy` dependencies are completed. Never infer a human approval or replay an `in_progress` task.
- Launch adds no approval receipt, revision counter, replay log, cancellation path, rollback mechanism, or cleanup lifecycle of its own.

Any durability claim in this skill is a claim about the files on disk, not about a hidden runtime.

## Phase 0 — Entry

- Brief self-check before anything else: does the brief name an objective, a scope boundary, and non-goals? If two or more are missing, say so and ask for one sharpening pass — running the pipeline on a soft brief converts ambiguity into confident-looking output.
- Spec path supplied → read it, jump to Phase 2.
- Mission brief → Phase 1.
- Single-point fix → hand off to execute, exit.

## Phase 1 — Converge (human decides, agent prepares)

Run the interview with the design-tree protocol: map decisions and their dependencies, then work in **frontier rounds** — batch every currently-askable question into one round, numbered, each with a recommended answer. The human answers; the tree reshapes; recompute the frontier. Facts are always self-served by sub-agents from repo evidence — the human is asked only what no amount of exploration can settle.

Paper trail, written the moment each item settles:
- domain vocabulary → `CONTEXT.md` at repo root (lazy creation, one entry per term)
- decisions passing the ADR test (hard to reverse, surprising without context, real tradeoff) → `docs/adr/NNNN-<slug>.md`
- business rules and background discovered during convergence → `docs/business/` (one article per business question, opening paragraph states why it matters)

Non-convergence here is normal work, not a failure: if the frontier will not empty, present the residual questions ranked — this is C2's input, not an error.

## Phase 2 — Spec synthesis (agent drafts → C2 approves)

Synthesize `.omc/specs/<feature-slug>/spec.md`:

```
# <Feature> Spec
## Problem
## Solution
## User Stories        (numbered, each with testable acceptance criteria)
## Implementation Decisions
## Testing Decisions   (external behavior only)
## Out of Scope
```

Draft all of it, then stop at **C2**: present the acceptance criteria and the test seam list for human approval. Seams are selected by repo evidence and the deep-module discipline (public interfaces, existing test seams, depth analysis); the human confirms or corrects the list — a seam the human has not approved gets no tests.

Durability gate (agent-enforced, no approval needed): spec and tickets carry contracts, never coordinates — no file paths, no line numbers. Fragments encoding a decision better than prose (state machines, reducers, schemas) are the exception and state their origin.

## Phase 3 — Ticket decomposition (agent drafts → C3 approves)

Split into vertical slices under `.omc/specs/<feature-slug>/tickets/`:

- `NN-slug.md`, one file per ticket, dependency-ordered, each declaring `blockedBy: [ids]`
- each ticket crosses every layer, is independently demonstrable, and fits one fresh context
- wide refactors go expand-contract: add the new form, migrate in batches, remove the old — each batch a ticket

Agent-side mechanical validation runs first (independence, demonstrability, context fit). Then **C3**: present granularity, blocking edges, and proposed merges/splits for human approval. Iterate until approved. Mark every ticket `ready-for-agent`.

Integration-wiring rule: every vertical slice includes its own wiring and a smoke assertion — a slice whose output nothing mounts, serves, or imports is not done. Cross-slice seams that no single slice owns (route mounting, static serving, entry-point wiring) get an explicit integration ticket as the last frontier item.

## Phase 4 — Run the frontier

The frontier is every ticket whose blockers are all complete.

**Parallel (default, 2+ tickets).** Hand tickets to team: each ticket becomes a team task, `blockedBy` edges carry over — team's claim mechanics pick only frontier tasks. Spawn N workers. Each worker implements with the tdd discipline at the seams approved in C2; a ticket closes only after code-review passes on the diff, declared by the reviewer — the implementer never self-approves.

**Serial (single ticket, or `--serial`).** Delegate one ticket at a time to an executor subagent; same review gate.

**C4 — decisions that emerge mid-run.** When a parallel Team worker hits a decision passing the ADR test, it stops before decision-dependent mutation, records the question (options, recommendation, reversibility note) in the task result and `.omc/specs/<feature-slug>/decisions-pending.md`, and exits through Team's supported `in_progress` → `failed` transition. That Team batch is terminal failed evidence: do not reopen the task, create an in-run successor, or force normal shutdown/cleanup. Resolve the human decision at the next batch boundary, then start a fresh Team run with a new team name and tasks derived from the recorded artifacts.

Before any dispatch in the fresh batch, create each question as a normal numeric Team decision task and pre-assign it to a configured Team worker (for example, the designated reviewer/decision worker). The decision task follows Team's supported `pending` → `in_progress` → `completed` lifecycle. Create the replacement implementation task separately in `pending` with the decision task ID in the public Team `blocked_by` field. The configured worker claims the decision task, the lead presents the question batch to the human and records the answer in the decision log/ADR, then the worker completes the decision task from that recorded answer. Team's existing task-ID dependency resolution rejects an early implementation claim and makes it eligible only after the decision task is completed. The team lead never claims a task unless it is explicitly registered as a Team worker. If a decision is visible before first dispatch, create this dependency pair in the current fresh run. All dependencies are declared at task creation, before any worker claim; Launch never dynamically mutates a claimed task's dependencies.

**Serial C4 (`--serial`).** The executor stops before decision-dependent mutation and returns the question without claiming completion. Record and resolve the human question at the batch boundary, then start a fresh executor successor with the recorded answer and remaining acceptance criteria. Do not replay or resume the interrupted executor context, and do not manufacture Team tasks when Team is not active.

**Repeated failure stop.** The same verification failure surviving three repair attempts halts that lane with a root-cause hypothesis for the human. This is the one condition that interrupts C4's batching immediately.

## Phase 5 — Closeout (agent reports → C5 accepts)

- all tickets terminal with evidence → run verify across the whole change
- reconcile the paper trail: CONTEXT.md accurate, ADRs complete, spec updated where implementation taught it something
- emit the **completion report**: shipped scope, verification evidence, paper-trail locations, and Open Assumptions ranked by how much a human would likely want to veto them

## Context hygiene

- Phases 1–3 in one unbroken context window; compact at phase boundaries only (HUD high water is the signal).
- Long headless runs: prefer `--output-format stream-json` (or periodic progress markers) so the orchestrator sees liveness — plain text mode emits nothing until the turn ends.
- Phase 4 runs in fresh contexts per ticket by construction (team workers or subagents).
- Handoffs pass pointers, never content.
- Session died mid-run: resume only at a batch boundary using the lifecycle posture above; pending C4 questions survive in `decisions-pending.md`, while Team remains authoritative for runtime state.

## Completion definition

All tickets terminal with evidence, verify clean on the whole change, paper trail reconciled, report emitted — and every decision the agents made on the human's behalf is answerable with one pointer to where it was recorded.
