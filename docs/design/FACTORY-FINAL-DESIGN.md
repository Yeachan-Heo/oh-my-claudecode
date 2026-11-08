# Software Factory — Final Design

**Status:** design contract; synthesized from the Patterns-of-Work foundation (13 terms), the mattpocock/skills v1.3 borrowings, and the shipped enforcement layer (#4117, #4142, #4143, #4113)
**Owner:** Yeachan-Heo (decisions marked **[OWNER]**)
**Predecessors:** #4113 (dark-factory gaps), #4141 (P2 contract), #4142 (run ledger), #4143 (intake CLI), T6 acceptance (8/8)

## 0. Design stance

The Patterns-of-Work vocabulary is the factory's specification: each of the 13 terms is a foundation stone, each stone yields one design rule, and the factory stands on all 13 or it is not done. The goal shape is a **software factory** — triggers start sessions, humans sit at named gates — with **dark-factory mode structurally prevented for merges** (review-approve is always human). Borrowings from mattpocock/skills v1.3 are adopted as mechanics, never as text.

## 1. The full loop

```
TRIGGERS                 CHAIN                      SESSION (AFK link)              GATES                    LEDGERS                 REFLECTION
issue created/labeled ──▶ listener ──▶ spawn-next ──▶ headless session ──▶ SessionEnd ──▶ gradeGate ──▶ run ledger ──▶ chain ends ──▶ refit
cron (intake schedule) ──▶                          (AFK profile:                  (reason → outcome)  (human/auto)  (closeout     (stall      (mechanical →
CI failure ─────────────▶ [to build: check-run route]  narrow tools,               SessionEnd enqueuer (3 criteria,   flag)         watchdog    checks; judgment
session ended ──────────▶ chain enqueuer ──▶         budget guard,                route table SSOT)   4 gates)                     (30 min)    → standards)
                                        checks+review gates)
```

Humans sit only at the graded gates; everything between gates runs AFK.

## 2. Foundation stones → design rules → state

| Stone | Design rule | Mechanism | State |
|---|---|---|---|
| Human-in-the-loop | humans can sit anywhere; which decisions stay human is the main design question | 4 named gates, graded by `gradeGate` | ✅ shipped |
| AFK | before: kill ambiguity (grilling/spec/assumption protocol); during: checks + narrow tools; after: a PR worth reviewing | assumption protocol (#4113), `AFK_ALLOWED_TOOLS`, budget-guard, PR ending | ✅ shipped |
| Automated check | the only verification during AFK; **flaky = broken**; chain advances only on green checks | per-skill doctrine; **chain-level check gate: to build**; win32 flaky spawn tests: **to fix/bound** | ⚠️ partial |
| Automated review | fresh-context reviewer, scoped prompt, **filter before the human gate — not a gate** | code-reviewer agent exists; **not a chain stage: to build** | ⚠️ partial |
| Human review | **the diff is the primary source; the summary is not** | review-approve gate is human; **diff-first requirement: to build** | ❌ violates stone |
| Vibe coding | the stance the factory makes explicit; visibility of dark vs gated areas | factory status view (#4180) | 🟡 open PR |
| Design concept | concept before fixation; spec too early durably captures misalignment | intent stage (non-engineer intake → review → accepted) | ✅ T6-validated |
| Grilling | one decision at a time, recommended answers | deep-interview (ambiguity scoring, frontier batching) | ✅ shipped |
| Prototyping | when words are too low-fidelity | loft | ✅ shipped |
| DX | the human contrast; informs where AX investment differs | — | — |
| AX | the environment is the only support in AFK runs | state-root fix (#4115), skill map (#4116), narrow tool profile, lean inventory | ✅ shipped |
| Software factory | triggers start sessions; **start small** (narrow loop → trust → widen); 4 trigger classes | listener (issue) ✅, intake schedule (cron) ✅, session-end enqueuer ✅, **CI-failure route: to build**, **narrow starter loop: to build** | ⚠️ 3/4 triggers |
| Dark factory | structurally prevented for merges; made visible where it exists | review-approve always human (gradeGate); status view (#4180) | ✅ prevented + visible |

## 3. Component design (shipped vs to build)

### 3.1 Trigger layer

- **Issue webhook** ✅ — listener daemon: HMAC, repo whitelist, intake label gate, serial.
- **Cron** ✅ — `omc intake schedule` (host-native timer, no daemon) → headless sweep.
- **Session end** ✅ — chain enqueuer: reason → outcome → route table → next link.
- **CI failure** ⚠️ **to build** — check-run failure webhook → listener route → diagnose/fix session (`diagnose:ci-failure` route entry). Same HMAC/whitelist path as issue intake.
- **Narrow starter loop** ⚠️ **to build** — `omc factory init --narrow`: one cron trigger + one session type + one reviewable PR (the "one lint rule a night" shape). The start-small configuration ships as the default; the full-pipeline route table is the widening, gated on the narrow loop's review track record.

### 3.2 Chain layer

- Route table SSOT ✅ (`.omc/factory-routes.json`, #4176). **`omc factory init` to build** — seeds the route table (narrow loop by default, full pipeline as widening), validates harbor labels and shipyard prerequisites, documents the format; makes `DAILY_CHAIN_LIMIT` configurable (env override, default 10).
- Gate grading ✅ (3 criteria + mechanical checks; intent-accept and review-approve always human).
- Guardrails ✅ (serial single-session, daily cap); **cap configurability included in factory init**.
- Watchdog ✅ (stall detection → `harbor:need-info`); stall naming + status view in #4180.

### 3.3 Session layer (the AFK link)

- **Before** ✅ — grilling (deep-interview), design-concept building (intent), prototyping detour (loft), assumption protocol.
- **During** ✅/⚠️ — budget guard (shipped); AFK tool profile (shipped); **tdd-driven implementers to build**: factory build-stage links mandate the tdd skill (implement-spec v1.3 mechanic — implementers call tdd, never free-form); **integration disciplines to build**: base-reset at start + integration-tip pull before reporting (implement-spec v1.3 mechanics — bounds drift to one work session); **check gate to build**: the link's checks must run green before the SessionEnd reports success.
- **After** ✅/⚠️ — ends in a PR worth reviewing (diff attached); run ledger + reconciliation (shipped).

### 3.4 Gate layer

- gradeGate ✅ — 3 criteria; intent-accept and review-approve structurally human.
- **Diff-first human review to build** — a review-approve signoff must attach the diff or changed-file list (primary source); summary-only signoffs are recorded as invalid. Fixes the one foundation-stone violation (stone 5).
- **Automated review stage to build** — before review-approve, a fresh-context reviewer agent (scoped system prompt: security/contract/performance per change type) runs as a filter; the human gate sees the filtered findings plus the diff. The filter never replaces the gate.

### 3.5 Ledger layer

- Run ledger ✅ (#4142), enforcement shadow log ✅ (#4117), chain ledger ✅ (#4153 family), reconciliation ✅.
- **Factory status view** — #4180 (open): names silent stalls, shows dark vs gated areas per the vibe-coding stone.

### 3.6 Reflection layer

- refit ✅ (user-invoked; categories match the retro skill's).
- **Chain-termination → refit trigger to build** — implement-spec v1.3 places retro as the step that "closes the loop; the next build starts from a better environment". The factory route table gains a terminal edge: chain end → refit suggestion (advisory). Mechanical mistakes become checks; judgment calls become standards — the loop Matt draws, wired into our chain.

## 4. Borrowings from mattpocock/skills v1.3 (mechanics only, never text)

| Borrowing | Source | Lands in |
|---|---|---|
| Integration-branch goal framing | implement-spec v1.3 | build-stage link doctrine |
| Tracker pointer (ticket status source) | implement-spec v1.3 | chain ledger `tracker` (already shipped) |
| tdd-driven implementers | implement-spec v1.3 | build-stage link gate |
| Worktree base-reset + tip-pull | implement-spec v1.3 | build-stage link conventions |
| Draft PR after first merge (empty branch can't open one) | implement-spec v1.3 | PR timing in the chain |
| Retro closes the loop | retro graduated + ask-matt placement | chain-termination → refit trigger |
| pr is model-invoked | pr graduated | our pr skill stays model-invocable |
| Glossary naming (`GLOSSARY.md`, collision with agent-context) + `GLOSSARY-MAP.md` multi-context map | v1.3 rename | **[OWNER]** breaking rename — adopted 2026-10-09: follow the upstream v1.3 rename (spec #61) |
| Start-small narrow loop | software-factory essay | `omc factory init --narrow` default |
| Retro's environment categories | retro skill | refit (already absorbed, #4110) |

## 5. Defect register (foundation-stone violations and gaps)

1. **Stone 5 violation** — review-approve accepts summary-only signoffs. Fix: diff-first requirement (§3.4).
2. **Stone 4 gap** — no automated-review stage in the chain. Fix: §3.4.
3. **Stone 3 poisoning** — win32 flaky spawn tests; no chain-level check gate. Fix: bound or fix (§3.3).
4. **Stone 12 gap** — CI-failure trigger missing. Fix: §3.1.
5. **Start-small missing** — full-pipeline route table as the only config. Fix: narrow starter default (§3.1).
6. **Adoption gaps** — route-table authoring story, cap configurability, shipyard prerequisite check. Fix: `omc factory init` (§3.2).

## 6. Sequencing

1. Land #4180 + #4179 (visibility + AFK verify commands).
2. **This contract's implementation waves**: (a) diff-first review doctrine + automated-review stage; (b) chain check gate + win32 bounding; (c) `omc factory init` + CI-failure trigger; (d) narrow starter loop config.
3. Shadow accumulation on real usage → promotion per protocol (≥20 samples, zero false blocks) **[OWNER]**.
4. T7 acceptance: full pipeline chained on a real repository — the actual "fully implemented" verdict.

## 7. Non-goals

No dark-factory mode for merges (structurally prevented). No auto-resume. No inferred approvals. No production-monitoring daemon (ecosystem seam). No daemon beyond the opt-in listener.
