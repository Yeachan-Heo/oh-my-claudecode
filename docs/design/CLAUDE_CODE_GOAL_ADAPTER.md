# Claude Code `/goal` Adapter Design

## Context

Claude Code exposes `/goal` as a native, session-scoped work loop. OMC can use that loop as an execution surface, but OMC must keep its own durable audit trail, hook safety rules, and Ralph/Team boundaries. The adapter described here is a design contract for future implementation; it does not mutate hidden Claude Code goal state.

## Source authority boundary

Claude Code `/goal` facts in OMC docs and code comments must come only from Claude Code or Anthropic sources, such as:

- Claude Code docs: <https://code.claude.com/docs/en/goal>
- Anthropic Claude Code changelog: <https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>

OpenAI, Codex, OMX, or OMO references may be used for comparisons with their own goal/runtime behavior, but they are not authority for Claude Code `/goal` facts.

## Adapter responsibilities

The Claude Code `/goal` adapter is an OMC-facing boundary that renders safe handoff text and durable evidence. It must:

1. Detect or receive a capability verdict for `/goal` before suggesting native handoff.
2. Render a measurable `/goal <completion condition>` handoff prompt instead of writing hidden Claude Code session state directly.
3. Preserve OMC auditability by recording the requested condition, status snapshots, surfaced evaluator reasons, command evidence, and final review outcome in OMC-owned artifacts.
4. Refuse or degrade when workspace trust, hook settings, or managed-hook policy makes `/goal` unavailable.
5. Enforce one active loop authority per session so `/goal` does not compete with Ralph, Team, autopilot, or Stop-hook continuation loops.

## Goal contract subset

Future implementation should map each goal item into the shared durable contract below:

| Field                  | Required behavior                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `goal_id`              | Stable repo-local identifier for handoffs, checkpoints, and review.                                             |
| `objective`            | Human-readable outcome.                                                                                         |
| `completion_condition` | Measurable condition suitable for `/goal <condition>` handoff.                                                  |
| `runtime_target`       | `claude-code-goal` for native `/goal`, or `artifact-only` fallback.                                             |
| `loop_authority`       | Exactly one primary authority: `claude-code-goal`, `ralph`, `team`, `autopilot`, or `artifact-only`. |
| `conflict_policy`      | One of `refuse`, `adopt_existing`, or `artifact_only`.                                                          |
| `source_refs`          | Claude Code `/goal` claims cite only Claude Code/Anthropic sources.                                             |
| `evidence`             | Surfaced command output, docs updates, test output, reviewer verdicts, and status snapshots.                    |
| `status`               | Distinguishes evaluator success from OMC final review: `evaluator_passed` is not `complete`.                    |

## Deterministic loop conflict policy

When another primary loop is active, the adapter must apply one of these deterministic policies and record the decision in evidence:

| Policy           | Behavior                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `refuse`         | Stop before rendering a `/goal` handoff. Explain the active authority and the exact command or state the user must clear first. |
| `adopt_existing` | Keep the existing loop authority and attach the goal contract as evidence/checkpoints for that loop. Do not start `/goal`.      |
| `artifact_only`  | Write the durable goal ledger and handoff artifact only. Do not ask Claude Code to activate `/goal`.                            |

The adapter must never “warn and continue” with a competing loop. Any unknown policy is invalid and must fail with an actionable diagnostic.

## Availability and fallback matrix

| Condition                                                       | Adapter result                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/goal` supported, trusted workspace, no competing loop         | Render `/goal <condition>` handoff and record intended loop authority.                    |
| Hook-disabling settings block `/goal`                           | Use `refuse` or `artifact_only`; include the hook policy in diagnostics.                  |
| Managed hooks prevent `/goal`                                   | Use `refuse` or `artifact_only`; do not suggest bypassing policy.                         |
| Workspace is not trusted                                        | Refuse native handoff until trust is established, or create artifact-only evidence.       |
| Ralph/autopilot/Stop-hook/Team is already authoritative | Apply `conflict_policy` exactly.                                                          |
| Capability cannot be determined                                 | Prefer `artifact_only` unless the user explicitly requests manual native `/goal` handoff. |

## Handoff rendering contract

A native handoff must be explicit and verifiable:

```text
/goal Complete <objective> when <measurable condition>. Before claiming completion, surface evidence from: <proof command>, <docs check>, and <final review checkpoint>.
```

Handoff text must remind the agent that the `/goal` evaluator judges surfaced conversation evidence. It must not imply that the evaluator independently reads files or runs commands.

## Final review gate

OMC completion requires a final review after any `/goal` evaluator success:

1. `/goal` evaluator passes from surfaced evidence.
2. OMC records `evaluator_passed` with the status snapshot/evaluator reason.
3. OMC runs or records required verification evidence.
4. A final reviewer marks `complete`, `review_blocked`, or `failed`.

Direct `evaluator_passed -> complete` transitions are invalid because they skip OMC-owned verification.

## Storage boundary

The adapter should use logical artifact names first and resolve them through OMC runtime paths second:

| Logical artifact    | OMC path intent                                                |
| ------------------- | -------------------------------------------------------------- |
| Goal ledger         | `.omc/goals/` or the configured OMC state root.                |
| Handoff artifact    | `.omc/context/` or configured handoff directory.               |
| Completion evidence | `.omc/goals/<goal_id>/evidence/` or configured evidence store. |

Docs may compare OMX `.omx` or OMO-native paths, but OMC adapter code must not require `.omx/` to exist in an OMC-only workspace.
