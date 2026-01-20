---
description: Cancel active Ralph (and ultrawork + ralph if active)
---

[RALPH CANCELLED]

Ralph has been cancelled. You MUST now deactivate the state files.

## MANDATORY ACTION

Execute this command to fully cancel ALL persistent modes:

```bash
mkdir -p .omc ~/.claude && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > .omc/ralph-state.json && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > .omc/ultrawork-state.json && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > .omc/ralph-plan-state.json && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > ~/.claude/ralph-state.json && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > ~/.claude/ultrawork-state.json && \
rm -f .omc/ralph-verification.json
```

After running this command, you are free to stop working. The persistent mode hook will no longer force continuation.

## What Was Cancelled

- **Ralph**: Self-referential completion loop
- **Ralph Plan**: Iterative planning loop (if active via /ralplan)
- **Ultrawork State**: Maximum intensity mode (if combined with ultrawork)
- **Verification State**: Any pending architect verification

## To Start Fresh

- `/ralph "task"` - Start ralph only
- `/ultrawork "task"` - Start ultrawork only
