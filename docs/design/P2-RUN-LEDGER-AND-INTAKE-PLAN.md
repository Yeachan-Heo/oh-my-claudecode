# P2: Run ledger and intake CLI — the runtime contract for closeout enforcement and scheduled intake

**Status:** planning-only architecture contract; no runtime behavior changes in this PR
**Origin:** the doctrine trial run and PR #4113/#4117 review cycle; the enforcement-layer design (E0–E3) with E0/E2 already shipped (#4117)
**Owner:** Yeachan-Heo (final decisions marked **[OWNER]**)
**Base:** `origin/dev` at the head of the #4113 review cycle

## 1. Scope and non-goals

This document is the planning contract for the P2 wave: the runtime pieces of the enforcement layer that cannot live at the hook layer. It defines (A) a durable **run ledger** that makes closeout enforcement possible at all, and (B) an **intake CLI** that gives the harbor headless sweep its missing power switch. It intentionally does **not** change what skills instruct, auto-merge anything, auto-resume any run, infer any approval, or introduce a daemon — every scheduled surface is host-native (cron / Task Scheduler / launchd), never an OMC process.

Non-goals inherited from the #4113 review: nothing posts to a tracker or opens a PR without explicit authorization; the guardrail default remains whatever the owner decides on #4113 (this contract is agnostic to that flip).

## 2. Why a contract is needed (the design correction this document records)

The enforcement-layer design (E1) originally placed closeout enforcement in a Stop hook. Walking the real sequence invalidates that placement:

1. ralph Step 10 writes the run closeout to the notepad;
2. Step 8 runs `/oh-my-claudecode:cancel`, which **deletes the mode state file**;
3. the session stops; the Stop hook fires with **no state left to read**.

A Stop-hook closeout check can therefore never observe a legitimately finished run — it would only ever fire on the mid-run stops that persistent-mode already blocks. The companion idea ("have the stale-run watchdog notice missing closeouts") is equally void: the watchdog only sees **crashed** runs (state still `active`), and a crashed run legitimately has no closeout. Hard closeout enforcement needs a durable trace that survives cancel. That trace is the run ledger.

## 3. Part A — the run ledger

### 3.1 Shape

Append-only JSONL at `.omc/state/runs/ledger.jsonl` (respects `OMC_STATE_DIR` via the canonical state-root resolver). One line per lifecycle edge:

```json
{ "ts": "...", "run": "ralph", "sessionId": "...", "event": "start"|"end", "outcome": "running"|"completed"|"failed"|"cancelled", "closeoutWritten": true }
```

- **start** written when a mode state file transitions to `active: true` (single choke point: `state_write` in `src/lib/mode-state-io.ts` for the four watched modes).
- **end** written by the cancel/session-end/state-clear path (`state_clear` and the cleanup branches) **before** the mode state file is removed, carrying the outcome and a `closeoutWritten` flag computed by checking the mode's notepad for a write after `startedAt` (mtime comparison — cheap, no content parsing).
- The ledger is **not** wiped by cancel. It is the durable trace; mode state remains the ephemeral control plane. Rotation: lines beyond a bounded tail (e.g. 1,000) roll to `ledger.jsonl.1` — same pattern as other local logs.

### 3.2 Consumers

- **SessionStart reconciliation** (extends the stale-run reporter): for each `end` entry whose `closeoutWritten: false`, report one advisory line — "previous ralph run completed without a closeout; the run's friction was not captured." Advisory only; never mutates.
- **Promotion evidence**: the enforcement shadow log (`.omc/state/enforcement/shadow.jsonl`, shipped in #4117) gains closeout-rule samples only once the ledger exists — the ledger is the prerequisite for any closeout enforcement, hard or advisory.

### 3.3 Risks

- **Concurrency**: two sessions writing the ledger — append-only single-line writes with the existing state-lock helper; worst case an interleaved line, which the JSONL readers already tolerate.
- **Privacy**: the ledger carries only mode names, timestamps, and booleans — no prompts, no paths beyond the state root.
- **Compatibility**: `state_clear` callers today expect nothing in return; the write is additive and failure-swallowed (evidence by contract, mirroring `enforcement-log.mjs`).

## 4. Part B — the intake CLI

### 4.1 Surface

- `omc intake run --headless` — validates harbor preconditions (tracker reachable, the eight `harbor:*` labels, single-writer attestable), spawns one headless agent session running the harbor `sweep` argument with guardrails enabled, captures the docket link, posts it through `configure-notifications` when configured. Single process; exits when the sweep exits.
- `omc intake schedule --cron "<expr>"` / `omc intake schedule --off` — registers/removes a **host-native** scheduled entry (cron on Linux/macOS, Task Scheduler on Windows) pointing at `omc intake run --headless`. The timer belongs to the OS; OMC still runs no daemon (harbor's own non-goal is preserved verbatim).

### 4.2 Preconditions and refusals

Schedule installation refuses (loudly, no silent install) when: the tracker is unreachable; labels are missing and cannot be created; single-writer cannot be attested; or no notification channel exists **and** the user has not confirmed the docket-only fallback. A headless sweep never widens communication scope and never creates standing rules — those wait for a signed session (harbor's own contract, unchanged).

### 4.3 Risks

- **Credentials**: headless gh needs a token; the CLI surfaces exactly which credential is missing rather than degrading to a half-run.
- **Surface area**: this is the first `src/cli` change in the enforcement family — the bridge build chain must be exercised (`npm run build:cli`), and the CLI help snapshot tests updated.

## 5. Sequencing

1. **A** (run ledger) — one slice: ledger writes + SessionStart reconciliation + tests. No skill text changes.
2. **B** (intake CLI) — one slice: CLI + schedule contract + tests. Depends on nothing from A.
3. **E1 promotion** — after A ships and the reconciliation advisory accumulates samples, the closeout rule can move from advisory to enforced **[OWNER]**.

## 6. Open questions for the owner

1. **[OWNER]** Ledger location: `.omc/state/runs/ledger.jsonl` vs `.omc/logs/` — state (control-plane adjacent) or logs (audit-like)?
2. **[OWNER]** Retention bound for the ledger tail (proposed 1,000 lines, rotate on overflow)?
3. **[OWNER]** Should `omc intake schedule` be allowed to install without a notification channel (docket-only fallback), or is a channel mandatory?

## 7. Verification checklist for changes in this contract

1. Ledger write on activation, on cancel, on session-end crash path (simulate kill: no `end` entry — the gap is itself the signal the reconciliation reports).
2. Reconciliation advisory appears for `closeoutWritten: false` and stays silent for true closeouts.
3. Intake schedule install refusals covered (tracker down, labels missing, single-writer unattestable).
4. Hook latency budgets unchanged (Stop hooks remain ≤ their declared timeouts; ledger writes are on the cancel path, not the Stop path).
5. `dist/`/`bridge/` artifacts never committed; `npm run build`, `plugin:shipping:verify`, `prompt-ssot:check`, `lint` green.
