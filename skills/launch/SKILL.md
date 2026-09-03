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

Launch assumes the shipyard exists — and refuses to run if it does not. The yard gate is the first action of every invocation, before document-language resolution and before reading any supplied spec:

- **Run the full drydock `--check` audit** — missing surfaces, a missing or invalid `CONTEXT.md` frontmatter `documentLanguage`, dead paths, glossary terms unused in code, standards never referenced. This is the single criterion: Launch performs no separate facility inventory of its own.
- **Any finding hard-blocks the run:** list every finding verbatim, point at `/oh-my-claudecode:drydock`, state that the run never started and no artifacts were produced, and stop. No override flag, no confirm-to-continue path, no exception for throwaway prototypes — laying the yard is one command away.
- **A clean audit admits the run.** Every paper-trail slot (`CONTEXT.md`, `docs/adr/`, `docs/business/`) and facility surface already exists at that point; Launch fills the paper trail as decisions settle but never creates the slots.
- The rules entry is `CLAUDE.md` — the shipyard map recognizes no substitute.

## The boundary

| Human checkpoints (the critical 20%) | Agent continuous run (the mechanical 80%) |
|---|---|
| C1 author the mission brief (objective + scope) | fact-finding and repo exploration, self-served |
| C2 approve acceptance criteria + test seam list | interview preparation: frontier questions batched with recommended answers |
| C3 approve ticket decomposition (granularity, blocking edges) | spec and ticket drafting, mechanical validation (independence, demonstrability, fits-one-context) |
| C4 answer irreversible decisions that emerge mid-run (batched, async) | tdd implementation at agreed seams, builds, tests, regressions |
| C5 accept the completion report; veto via Open Assumptions and the per-line sediment list | code-review, verify across the change, team frontier scheduling, the whole paper trail |

Between checkpoints the pipeline never idles: agents keep working every frontier ticket that does not depend on a pending human answer.

## Lifecycle posture

Launch is a **stateless composition over OMC's existing lifecycle** — it owns no runtime state machine:

- Team owns task statuses, transitions, cancellation, and runtime cleanup; Launch never mutates them outside Team's contract.
- The canonical `plan` → `execute` → `review` → `verify` surfaces own their existing lifecycle behavior. Launch-authored artifacts are limited to `.omc/specs/<feature-slug>/`, `CONTEXT.md`, `docs/adr/`, and `docs/business/` — plus, only after C5 approval, the sediment slots named in the Phase 5 table.
- Launch has no automatic resume. After interruption, re-read the artifacts and current Team status, but continue only through a new explicit Launch invocation after the owning Team lifecycle has reached a supported terminal/cleanup boundary. Never infer a human approval or replay an `in_progress` task.
- Launch adds no approval receipt, revision counter, replay log, cancellation path, rollback mechanism, or cleanup lifecycle of its own.

Any durability claim in this skill is a claim about the files on disk, not about a hidden runtime.

## Phase 0 — Entry

A run reaches this phase only through a clean yard gate. Before reading a supplied spec or entering Phase 1, resolve the document language. An explicit human choice in the current invocation wins; otherwise read a valid BCP-47-style tag from `CONTEXT.md` frontmatter at the exact stable key `documentLanguage`; otherwise require unanimous high-confidence inference from `CLAUDE.md` then `README.md`. A persisted bare or region-only Chinese tag is script-ambiguous and must be asked once at that authority tier, never bypassed by inference. Missing, mixed, conflicting, low-confidence, invalid-explicit, or script-ambiguous Chinese evidence requires one batched language question; do not guess. Chinese must resolve to an explicit `zh-Hans` or `zh-Hant` script tag. `zh-Hans-*` selects the Simplified companion and `zh-Hant-*` selects the Traditional companion while the full normalized tag is persisted. Persist the resolved normalized tag back to `CONTEXT.md` before any Launch-authored artifact so a fresh explicit invocation can read it without hidden conversation state. The human reads and maintains these artifacts; agents are language-agnostic.

Localize prose and human-facing labels/localizable scalar values only. Paths, slash commands, flags, code fences, placeholders, frontmatter keys and machine-semantic values, YAML/JSON keys, lifecycle tokens (`plan`, `execute`, `review`, `verify`), status enums (`pending`, `in_progress`, `completed`, `failed`, `ready-for-agent`), IDs, ticket `blockedBy`, public Team `blocked_by`, and all parser/control tokens remain byte-for-byte stable. Reference language companions are mutually exclusive: emit exactly one selected rendering, never bilingual duplicate headings or labels.

- Brief self-check before anything else: does the brief name an objective, a scope boundary, and non-goals? If two or more are missing, say so and ask for one sharpening pass — running the pipeline on a soft brief converts ambiguity into confident-looking output.
- Spec path supplied → read it, jump to Phase 2.
- Mission brief → Phase 1.
- Single-point fix → hand off to execute, exit.

## Phase 1 — Converge (human decides, agent prepares)

Run the interview with the design-tree protocol: map decisions and their dependencies, then work in **frontier rounds** — batch every currently-askable question into one round, numbered, each with a recommended answer. The human answers; the tree reshapes; recompute the frontier. Facts are always self-served by sub-agents from repo evidence — the human is asked only what no amount of exploration can settle.

Paper trail, written the moment each item settles:
- domain vocabulary → `CONTEXT.md` at repo root (one entry per term)
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

**C4 — decisions that emerge mid-run.** When a parallel Team worker hits a decision passing the ADR test, it stops before decision-dependent mutation, records the question (options, recommendation, reversibility note) in the failed transition's `error` field and `.omc/specs/<feature-slug>/decisions-pending.md`, and exits through Team's supported `in_progress` → `failed` transition. This is a terminal Launch outcome: do not reopen the task, create an in-run successor, force cleanup, or start another Team from this invocation. Surface the blocker with pointers to the failed task and decision artifact.

On a later explicit Launch invocation, first require the owning Team lifecycle to be terminal and cleaned up through its supported owner. Then batch every pending C4 question for the human, record the answers in the decision log/ADRs, and rebuild the ticket frontier before starting execution. All ticket dependencies are declared before dispatch: ticket `blockedBy` metadata maps to the public Team `blocked_by` field with numeric task IDs when tasks are created through the Team task API. Team's existing task-ID dependency resolution rejects early claims and makes dependents eligible only after their predecessors complete. The team lead never claims a task unless it is explicitly registered as a Team worker. Launch never dynamically mutates a claimed task's dependencies and never promises automatic re-dispatch after C4.

**Serial C4 (`--serial`).** The executor stops before decision-dependent mutation and returns the question without claiming completion. Record and resolve the human question at the batch boundary, then start a fresh executor successor with the recorded answer and remaining acceptance criteria. Do not replay or resume the interrupted executor context, and do not manufacture Team tasks when Team is not active.

**Repeated failure stop.** The same verification failure surviving three repair attempts halts that lane with a root-cause hypothesis for the human. This is the one condition that interrupts C4's batching immediately.

## Phase 5 — Closeout (agent reports → C5 accepts)

- all tickets terminal with evidence → run verify across the whole change
- reconcile the paper trail: CONTEXT.md accurate, ADRs complete, spec updated where implementation taught it something
- yard re-check: re-run the drydock `--check` audit; any new findings since entry are reported as **yard drift**, with a pointer to `/oh-my-claudecode:drydock`
- **sediment pass — answer: what did this ship teach the yard?** Sweep the source checklist first (three-strike failure root causes, C4 answers, review rejections, verify findings), then answer. Propose every lesson as `lesson → slot → intended change` against the slot table below, or decline it explicitly with a reason; a ship with nothing to teach must say so verbatim as "no new lessons". This requirement blocks non-answers, never empty answers — inventing lessons to have one is the same violation as skipping the question. The lesson list rides in the completion report next to the Open Assumptions, each line individually vetoable; approved lessons are written to their slots only after acceptance, and the report records each landing's file location.

  | Lesson kind | Slot |
  |---|---|
  | terms and boundaries settled mid-run | `CONTEXT.md` glossary |
  | checkable behavior rules (carry a why) | `docs/standards/` matching volume (architecture / data / process) |
  | most-violated conventions (thin-entry grade) | `CLAUDE.md` body — propose only |
  | hard-to-reverse decisions | `docs/adr/` (C4 answers already land here) |
  | business rules / background | `docs/business/` |
  | UI patterns / component contracts | `design-system/` |
  | reusable craft | `.omc/skills/` (through the skillify gate) |
  | repeatedly needed automation / integrations | `scripts/` or `.mcp.json` |
  | no slot fits | decline explicitly with the reason |

- **thin-entry budget:** the `CLAUDE.md` body carries at most five hot entries. A promotion proposal that would exceed the budget must demote the coldest hot entry in the same proposal, moving its full text back to `docs/standards/` — nothing is deleted, only re-tiered. Bloat is rebalanced ship by ship and is deliberately not a `--check` finding.
- emit the **completion report**: shipped scope, verification evidence, paper-trail locations, yard-drift findings (if any), the sediment list (each line vetoable), and Open Assumptions ranked by how much a human would likely want to veto them

## Context hygiene

- Phases 1–3 in one unbroken context window; compact at phase boundaries only (HUD high water is the signal).
- Long headless runs: prefer `--output-format stream-json` (or periodic progress markers) so the orchestrator sees liveness — plain text mode emits nothing until the turn ends.
- Phase 4 runs in fresh contexts per ticket by construction (team workers or subagents).
- Handoffs pass pointers, never content.
- Session died mid-run: preserve the artifacts and stop. A later explicit invocation may continue only after the owning Team lifecycle reaches its supported terminal/cleanup boundary; Team remains authoritative for runtime state.

## Completion definition

All tickets terminal with evidence, verify clean on the whole change, paper trail reconciled, report emitted — and every decision the agents made on the human's behalf is answerable with one pointer to where it was recorded.
