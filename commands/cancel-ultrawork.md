---
description: Cancel active Ultrawork mode
---

[ULTRAWORK CANCELLED]

The Ultrawork mode has been cancelled. Clearing state files.

## MANDATORY ACTION

Execute this command to cancel Ultrawork:

```bash
mkdir -p .sisyphus && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ultrawork"}' > .sisyphus/ultrawork-state.json && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ultrawork"}' > ~/.claude/ultrawork-state.json
```

After running this command, ultrawork mode will be deactivated and the HUD will update.

## To Start Fresh

- `/ultrawork "task"` - Start ultrawork only
