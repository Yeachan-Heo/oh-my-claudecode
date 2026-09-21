# #3669 — Jev-powered judgment points with heuristic degradation

Status: **ready-for-agent**
Branch: `feat/intent-skill` (to be cut as `feat/jev-judgment-points` when work starts)
Date: 2026-09-20
Glossary: `CONTEXT.md` § Jev integration
ADR: `docs/adr/03665-jev-degradation-contract.md`

## Problem Statement

OMC's orchestration makes dozens of narrow decisions per session — which skill
or mode to trigger, which model tier to route a task to, whether an autonomous
loop should keep going, which context to prune. Today every one of these is
decided by keyword lists, regexes, or prose instructions to the main model:
misfires on phrasings the keyword list didn't anticipate, no calibrated
confidence, no way to measure how good a decision was, and latency/cost paid
even when the decision is trivial.

A System One model (Jev) answers exactly this shape of question: state in,
typed judgment out, calibrated probabilities, ~100ms, fractions of a cent.
The problem is not that OMC lacks the judgments — it is that the judgments
have no clean seam, no measured quality, and no way to upgrade the mechanism
without rewriting each site.

## Solution

Every narrow decision in OMC's orchestration becomes a **judgment point**: a
single named decision with two implementations — the existing **heuristic
twin** and a Jev implementation — behind one resolver. Jev is opt-in via
environment configuration; unconfigured, timed out, unavailable, or over
budget, the judgment point runs in **degraded mode** (the heuristic twin) and
the workflow never blocks on Jev. Each judgment point rolls out through
**shadow mode**: both implementations run, Jev's answer is recorded but not
acted on, and promotion to active requires recorded evidence that Jev matches
or beats the twin.

The user-visible effect: OMC triggers the right skill more robustly, routes
tasks to the right model tier more accurately, and stops ralph/autopilot loops
on evidence of completion instead of keyword heuristics — and users who never
configure anything see zero behavior change.

## User Stories

1. As an OMC user, I want my prompt's intent classified by a decision model instead of a keyword list, so that phrasings the keyword list never anticipated still trigger the right skill.
2. As an OMC user, I want loop continuation decided on evidence of substantive progress, so that ralph stops when the work is done instead of when a keyword stops matching.
3. As an OMC user, I want model-tier routing to consider what the task actually is, so that simple tasks stop paying opus latency and cost.
4. As an OMC user who never configures Jev, I want zero behavior change, so that my existing workflow is untouched.
5. As an OMC user with a `TYPESAFE_API_KEY`, I want Jev judgment to light up by just setting the key, so that adoption is one env var.
6. As a cost-sensitive user, I want a per-session request cap, so that a misbehaving hook can never run up a bill.
7. As a latency-sensitive user, I want a timeout on every Jev call, so that a slow API never makes my prompt feel laggy.
8. As a privacy-conscious user, I want only metadata and bounded excerpts sent to the judgment API, so that my repository contents stay local.
9. As a privacy-conscious user, I want the excerpt size configurable, so that I can choose between judgment quality and data exposure.
10. As a plugin maintainer, I want every judgment point implemented twice behind one seam, so that I can eval the Jev implementation against the twin without touching call sites.
11. As a plugin maintainer, I want shadow data recorded per judgment point, so that promotion decisions are evidence-based.
12. As a plugin maintainer, I want per-point enablement (`off | shadow | active`), so that I can roll out points independently.
13. As a plugin maintainer, I want a circuit breaker, so that an API outage degrades every point after a few failures instead of paying the timeout on every call.
14. As a contributor, I want the judgment resolver as the single integration seam, so that adding judgment point #6 means registering a decision, not editing five hooks.
15. As a contributor, I want the resolver to log every shadow comparison, so that I can build evals from real traffic later.
16. As a maintainer, I want shadow logs under the ignored state root, so that recording comparisons never pollutes commits.

## Implementation Decisions

- **One seam, one module**: a judgment resolver that every hook consults. Inputs: point name, state, typed questions, heuristic twin result. Responsibilities: config resolution, degraded-mode gate, circuit breaker, shadow dispatch, shadow logging. Call sites never talk to the Jev client directly.
- **Zero-dependency Jev client**: hand-rolled `fetch` to `POST /v1/systemone` (model `jev-latest`). No official SDK. No retry on the interactive path; timeout via `AbortController`.
- **Config contract (env, following existing OMC kill-switch conventions)**:
  - `TYPESAFE_API_KEY` — presence enables Jev globally
  - `OMC_JEV=off` — master switch overriding key presence
  - `OMC_JEV=<point[,point...]>` — explicit per-point opt-in; unset = no points enabled (a key alone sends nothing anywhere, per owner review of #4058)
  - `OMC_JEV_TIMEOUT_MS` — per-call timeout, default `250`
  - `OMC_JEV_MAX_REQUESTS` — per-session request cap; exceeded → degraded mode for the rest of the session
  - `OMC_JEV_EXCERPT_CHARS` — max excerpt length sent in state, default `200`
- **Five judgment points, in delivery order**:
  1. **Intent classification** — Choice over the intent categories; twin is the in-flight intent-drafting classification logic on this branch; state is the user request excerpt plus conversation metadata.
  2. **Loop continuation** (ralph/autopilot persistent-mode Stop hook) — Noul ("is the task complete?") + Score ("substantive progress this iteration?"). Twin: the mode's existing Stop-hook completion criteria.
  3. **Skill/mode trigger** (keyword-detector, UserPromptSubmit) — Choice over triggerable skills/modes for the prompt. Twin: the keyword list. Async where the harness allows; shadow-first.
  4. **Model-tier routing** (pre-tool enforcer) — Choice over `haiku | sonnet | opus` given task metadata. Twin: existing tier-pinning rules.
  5. **Context pruning** (preemptive-compaction) — Score per candidate tool result on staleness. Twin: existing pruning heuristics.
- **Latency policy**: gate-type points (loop continuation) block with the timeout and degrade on timeout; detector-type points never block prompt submission — async where the harness allows, shadow-first regardless.
- **Circuit breaker**: 3 consecutive failures/timeouts per point → that point degrades for the rest of the session without further Jev calls.
- **Shadow log**: JSONL under the ignored state root, one line per comparison:
  `{ts, point, mode, state, heuristic, jev, confidence, durationMs}`. No repository code paths, no file contents beyond bounded excerpts.
- **State construction privacy**: metadata (paths, command names, counts) plus excerpts bounded by `OMC_JEV_EXCERPT_CHARS`. Never whole files. Applies to all five points.
- **Promotion is manual and evidence-based**: shadow data reviewed by a maintainer; a point flips to active only with evidence that Jev ≥ twin on real traffic.

## Testing Decisions

- **What makes a good test here**: external behavior only — given a stubbed HTTP transport, the resolver returns the twin's answer when the key is absent, the Jev answer when configured and the transport responds, the twin's answer on timeout/cap/master-off, and writes a comparison line in shadow mode. No mocking of internals; the transport stub is the only fake.
- **Modules tested**: the judgment resolver (config parsing, degraded-mode gates, circuit breaker, shadow logging, tri-state dispatch) and the Jev client (request shape, timeout, error mapping). The twins themselves stay covered by existing hook unit tests, unchanged.
- **Prior art**: the repo's existing hook unit-test suites that run hook scripts against fixture stdin JSON and assert emitted decisions; resolver tests follow the same shape with the transport stub injected via an env override (e.g. `OMC_JEV_ENDPOINT` pointing at a local stub server).

## Out of Scope

- Local/open-source Jev replicas (kev, NanoJev) as alternative backends.
- The official TypeSafe JavaScript SDK as a dependency.
- Auto-promotion from shadow to active, or an eval dashboard/UI.
- Changing any heuristic twin's behavior — twins are frozen baselines.
- The fact-forcing gate as an OMC judgment point (GateGuard is a separate harness layer); listed in the glossary enum aspirationally, inclusion needs an owner decision.
- Non-interactive/CI usage policy (rate limits, batching) — decide after interactive rollout data exists.

## Further Notes

- Live-account pricing measured 2026-09-20: $0.042/MTok input, output free; a typical hook call ≈ 300 input tokens ≈ $0.00001. Credit balance $4.89 with expiry — check expiry before long-lived CI use.
- Judgment point ① (intent classification) lands on the current `feat/intent-skill` branch first, as a shadow-mode module.
