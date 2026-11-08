# OpenClaw / Clawhip Routing Contract

This document defines the normalized event contract OMC emits through the OpenClaw bridge for native Clawhip-style consumers.

## Goals

- Keep the raw hook event (`event`) for backward compatibility.
- Add a normalized `signal` object for routing and dedupe-friendly filtering.
- Make command/native gateways receive the same logical payload shape as HTTP gateways.

## Payload shape

HTTP gateways receive JSON with this structure:

```json
{
  "event": "post-tool-use",
  "instruction": "...",
  "timestamp": "2026-03-09T00:00:00.000Z",
  "sessionId": "...",
  "projectPath": "...",
  "projectName": "...",
  "tmuxSession": "...",
  "tmuxTail": "...",
  "signal": {
    "kind": "test",
    "name": "test-run",
    "phase": "failed",
    "routeKey": "test.failed",
    "priority": "high",
    "toolName": "Bash",
    "command": "pnpm test",
    "testRunner": "package-test",
    "summary": "FAIL src/example.test.ts | ..."
  },
  "context": {
    "sessionId": "...",
    "projectPath": "...",
    "toolName": "Bash"
  }
}
```

## `signal` contract

| Field      | Meaning                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| `kind`     | Routing family: `session`, `tool`, `test`, `pull-request`, `question`, `keyword`  |
| `name`     | Stable logical signal name                                                        |
| `phase`    | Lifecycle phase: `started`, `finished`, `failed`, `idle`, `detected`, `requested` |
| `routeKey` | Canonical routing key for downstream consumers                                    |
| `priority` | `high` for operational signals, `low` for generic tool noise                      |

Additional fields may appear when applicable:

- `toolName`
- `command`
- `testRunner`
- `prUrl`
- `summary`

## Native command gateway contract

Command gateways now get the same normalized payload through both:

- template variable: `{{payloadJson}}`
- env var: `OPENCLAW_PAYLOAD_JSON`

They also receive convenience env vars:

- `OPENCLAW_SIGNAL_ROUTE_KEY`
- `OPENCLAW_SIGNAL_PHASE`
- `OPENCLAW_SIGNAL_KIND`

That lets native Clawhip routing consume one contract whether the transport is HTTP or shell-command based.

## Current high-priority route keys

- `session.started`
- `session.finished`
- `session.idle`
- `question.requested`
- `test.started`
- `test.finished`
- `test.failed`
- `pull-request.started`
- `pull-request.created`
- `pull-request.failed`
- `tool.failed`

Generic `tool.started` / `tool.finished` remain available as low-priority fallback signals.

## Noise reduction

- `AskUserQuestion` now emits only the dedicated `question.requested` signal instead of also emitting generic tool lifecycle events.
- OpenClaw now collapses repeated attached-tmux lifecycle bursts before dispatching them to downstream native gateways.
  - `session-start` collapses on `{projectPath, tmuxSession}` for a short burst window.
  - `keyword-detector` (the `UserPromptSubmit` bridge surface) collapses prompt-submitted bursts on `{projectPath, tmuxSession, normalized prompt}`.
  - `stop` / `session-end` collapse on `{projectPath, tmuxSession}` for a short burst window.
- Consumers should prefer `signal.priority === "high"` or explicit `signal.routeKey` filters instead of routing directly on raw hook names.

## Stability notes

- Raw `event` names are preserved for backward compatibility.
- `signal` is the preferred routing surface for new native Clawhip integrations.
- `context` remains a whitelisted subset; internal raw tool input/output are used only to derive normalized signals and are not forwarded in `payload.context`.
