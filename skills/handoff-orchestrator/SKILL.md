---
name: handoff-orchestrator
description: Follows &lt;handoff&gt; envelope chains across agents/skills automatically — reads the latest artifact's envelope, invokes next_recommended, loops until chain end, user input required, or halt. Interactive by default; --auto for unsupervised chains
argument-hint: "[<starting-artifact-path> | --auto | --max-steps=N]"
level: 4
---

# Handoff Orchestrator Skill

Thin orchestrator that follows handoff-envelope chains produced by OMC agents. Reads the latest artifact's `<handoff>` YAML block, invokes `next_recommended[0]`, loops. Stops at end-of-chain, user input required, or halt.

Enables token-efficient pipelines: each agent writes envelope + artifact; orchestrator routes based on envelope; downstream agents read only envelope by default.

## Usage

```
/oh-my-claudecode:handoff-orchestrator <artifact-path>        # follow from specific artifact
/oh-my-claudecode:handoff-orchestrator                        # auto-detect most recent artifact
/handoff-orchestrator <path> --auto                           # unsupervised; no per-step confirm
/handoff-orchestrator <path> --max-steps=5                    # safety cap on chain length
```

### Examples

```
/handoff-orchestrator .omc/ideas/2026-04-20-onboarding.md     # follow from ideate output
/handoff-orchestrator --auto                                   # follow most recent artifact unsupervised
/handoff-orchestrator .omc/strategy/2026-04-20-matching.md --max-steps=3
```

### Flags

- `--auto` — skip per-step user confirmation; invoke each `next_recommended[0]` automatically until halt or end-of-chain.
- `--max-steps=<int>` — safety cap (default 10). Protects against accidental loops.
- `--stop-at=<agent-name>` — halt chain when this agent becomes next_recommended (useful for pausing before human-heavy gates).
- `--include-optional` — follow not just `required: true` but also `required: false` handoffs (expands chain).
- `--dry-run` — show the chain that would execute; don't invoke.

<Purpose>
Automates agent-to-agent handoffs without requiring users to manually invoke each step. Reads `<handoff>` envelopes per the `docs/HANDOFF-ENVELOPE.md` standard, extracts `next_recommended`, invokes, continues. Preserves user control via interactive default (confirm between steps), with `--auto` for trusted chains.
</Purpose>

<Use_When>
- Agent produced an envelope with `next_recommended` items and you want to follow the chain without manual invocation per step.
- Running a workflow like ideate → critic → product-strategist → priority-engine where each step consumes the previous.
- Resuming a halted pipeline after remediation (envelope's `halt.resume_from` guides re-entry).
- Running scheduled agent chains unsupervised.
</Use_When>

<Do_Not_Use_When>
- No `<handoff>` envelope exists in the source artifact (agent is pre-v4.16 or doesn't follow the standard).
- You need fine-grained control over each step — manual invocation is clearer for exploratory work.
- Chain enters agents that fundamentally require human presence (design-partner sessions, interactive interviews).
</Do_Not_Use_When>

<Protocol>

## Phase 0 — Locate Starting Artifact

If positional arg provided, use that path.

Otherwise:
1. Glob `.omc/**/*.md` for files modified in the last 2 hours.
2. Filter to those ending with a `<handoff>` block.
3. Pick the most recently modified.
4. If ambiguous (multiple recent artifacts), list top 3 and ask user.

HARD STOP if no artifact with envelope is found.

## Phase 1 — Extract Envelope

Read the target artifact. Locate `<handoff>` and `</handoff>` markers (last occurrence if multiple). YAML-parse the contents.

Validate required fields: `schema_version`, `produced_by`, `produced_at`, `primary_artifact`, `next_recommended`. Missing required field → warn and halt with "malformed envelope" message.

## Phase 2 — Decision

Look at envelope's `primary_artifact.status` + `next_recommended`:

- `status: complete | approved` AND `next_recommended: []` → chain end. Report terminal summary and exit.
- `status: halted` → surface `halt.reason` + `halt.remediation`. Do NOT auto-invoke anything; user must remediate first.
- `requires_user_input` has `blocking: true` items → surface questions; stop.
- `next_recommended[0]` populated AND `required: true` → candidate for invocation.
- `next_recommended[0]` populated AND `required: false` → invoke only if `--include-optional` flag present.

Apply `--stop-at` if set: if `next_recommended[0].agent == <stop-at>`, report "stopping before <agent>"; exit without invoking.

## Phase 3 — User Confirmation (unless --auto)

Show the user:
```
Next step: <agent-name>
Purpose: <envelope purpose>
Context: <primary_artifact.path>
Required: <bool>
```

Ask: "proceed / skip / stop"?
- `proceed` (default): invoke the agent with directive to read the primary_artifact.
- `skip`: advance to `next_recommended[1]` if present; else exit.
- `stop`: exit chain with current state.

With `--auto`, skip confirmation; invoke directly.

## Phase 4 — Invoke

Invoke the target agent OR skill via Task-tool with directive:

```
Handoff-orchestrator invocation.
Upstream artifact: <primary_artifact.path>
Upstream signals (read envelope only, not full body):
  <key_signals from envelope>
Gate readiness:
  <gate_readiness from envelope>

Your task: <envelope purpose line>

If you produce a new artifact, append a <handoff> envelope per docs/HANDOFF-ENVELOPE.md.
```

Wait for completion. Detect new artifact written.

## Phase 5 — Loop

If the just-completed agent produced a new artifact with its own envelope, return to Phase 1 using that as starting point.

If it produced no envelope (non-compliant agent) → report "chain terminated — <agent> did not emit envelope" and exit gracefully.

Track step count; if `--max-steps` reached, halt and report.

## Phase 6 — Terminal Summary

At end of chain, emit:
```
Chain complete.
Steps executed: N
Final status: <last artifact's status>
Artifacts produced in chain: [<list>]
Final next_recommended: <if any>
```

</Protocol>

<Input_Contract>
Positional arg (optional): path to starting artifact with `<handoff>` envelope.

Flags:
- `--auto` — unsupervised mode (still stops at halts, blocking user input).
- `--max-steps=<int>` — chain length cap (default 10).
- `--stop-at=<agent>` — halt before invoking the named agent.
- `--include-optional` — follow `required: false` handoffs too.
- `--dry-run` — show planned chain without invoking.
</Input_Contract>

<Output>
- Terminal summary of the chain execution.
- No new artifacts written by orchestrator itself — downstream agents write their own.
- Audit log at `.omc/handoffs/orchestrator/YYYY-MM-DD-HHMM.md` with invocation timeline.
</Output>

<Failure_Modes_To_Avoid>
- **Invoking agents that don't follow the envelope standard.** If downstream agent produces no envelope, chain terminates gracefully — do NOT attempt to infer next step from prose.
- **Ignoring `halt` blocks.** A halt means remediation required; do NOT try to proceed.
- **Looping on same artifact.** Track invoked agents + artifact paths; detect cycles (same agent + same artifact twice → abort with cycle warning).
- **Running with no `--max-steps` cap.** Default 10 is enforced; `--max-steps=0` is explicitly rejected.
- **Treating optional handoffs as required.** `required: false` entries are NEVER auto-invoked without explicit `--include-optional` flag.
- **Re-reading full artifact body when only envelope is needed.** The whole token-saving point is envelope-first; only pass full body to the downstream agent when their directive explicitly requires it (e.g., critic needs the plan).
- **Silent handling of malformed envelopes.** If the YAML block exists but fails to parse, surface the error — don't guess.
- **Skipping `requires_user_input` blocking items.** These exist because an agent genuinely needs a user decision; auto-routing past them corrupts downstream work.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Consumes envelopes per `docs/HANDOFF-ENVELOPE.md` (schema_version: 1).
- Writes audit log to `.omc/handoffs/orchestrator/` for replayability.
- Composable with `/oh-my-claudecode:loop` for periodic chain continuation (e.g., after a design-partner session completes, resume).
- Pre-v4.16 agents don't emit envelopes; when chain reaches them, it terminates gracefully with "chain terminated" rather than errors.
- Can be combined with `/oh-my-claudecode:ralph` for retry-on-transient-failure at any single step.
</Integration_Notes>
