# Analytics System (Deprecated)

This document previously described legacy analytics commands/modules (`omc cost`, `omc sessions`, `omc backfill`, and `src/analytics/*`). Those interfaces are no longer part of the current CLI/runtime.

## Current Observability Surface

Use these supported runtime sources instead:

- HUD statusline output (`omc hud` or `/oh-my-claudecode:hud setup`)
- Replay logs: `.omc/state/agent-replay-*.jsonl`
- Token tracking log: `.omc/state/token-tracking.jsonl`

For broader monitoring guidance, see [Performance Monitoring](./PERFORMANCE-MONITORING.md).
