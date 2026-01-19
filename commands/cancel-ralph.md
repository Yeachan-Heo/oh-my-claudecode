---
description: Cancel active Ralph Loop (and ultrawork-ralph if active)
---

[RALPH LOOP CANCELLED]

The Ralph Loop has been cancelled. You MUST now deactivate the state files.

## MANDATORY ACTION

Execute this command to fully cancel ALL persistent modes:

```bash
mkdir -p .sisyphus ~/.claude && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > .sisyphus/ralph-state.json && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > .sisyphus/ultrawork-state.json && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > .sisyphus/ralph-plan-state.json && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > ~/.claude/ralph-state.json && \
echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > ~/.claude/ultrawork-state.json && \
rm -f .sisyphus/ralph-verification.json
```

After running this command, you are free to stop working. The persistent mode hook will no longer force continuation.

## What Was Cancelled

- **Ralph Loop**: Self-referential completion loop
- **Ralph Plan**: Iterative planning loop (if active via /ralph-plan)
- **Ultrawork State**: Maximum intensity mode (if active via /ultrawork-ralph)
- **Verification State**: Any pending oracle verification

## To Start Fresh

- `/ralph-loop "task"` - Start ralph loop only
- `/ultrawork "task"` - Start ultrawork only
- `/ultrawork-ralph "task"` - Start combined mode (recommended)
