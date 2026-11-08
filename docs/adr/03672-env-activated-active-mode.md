# Env-activated active mode: one env line enables every judgment point

Judgment points default to shadow, and the only path to active was the compile-time `ACTIVATED_POINTS` set, which is empty in every release — so Jev shipped but never decided anything. Promotion was designed as evidence-driven (shadow collection, jev-eval agreement report, ticket 07 promotion), but evidence cannot exist before someone can run Jev for real, and the compile-time set made that impossible without a code change: Jev was permanently inert.

## Solution

`OMC_JEV` entries accept an `:active` suffix: `OMC_JEV=task-size:active`, or `all:active` for every point, `all` for all-shadow. Env activation unions with code-time `ACTIVATED_POINTS` activation, and a warn-once stderr line (`[jev] <point>: ACTIVE via env — Jev decides`) makes the behavioral flip observable.

**Active mode behavior**:
- Blocking points: Jev answer gates behavior; timeout/error falls back to heuristic twin
- Non-blocking points (script-side): spawn synchronously and await Jev result (bounded by `OMC_JEV_TIMEOUT_MS`, default 2000ms); on timeout/error, use heuristic twin immediately
- Script hooks (pre-tool-enforcer, keyword-detector): when Jev provides an answer in active mode, that answer overrides the heuristic (model injection, skill override, etc.)

**Degrade-never-block**: Unchanged. Timeout, HTTP error, invalid response, request cap, and circuit-open still fall back to the heuristic twin. Shadow log keeps recording in active mode so the evidence chain continues.

**Rejected alternatives**:
- Separate `OMC_JEV_ACTIVE` env (two opt-in channels fork the opt-in semantics)
- Global `OMC_JEV_MODE=active` (too coarse — would flip gate-type points like ralph-verdict with no per-point control)

Status: accepted and implemented.
