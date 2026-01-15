---
description: Cancel active Ralph Loop
---

[RALPH LOOP CANCELLED]

The Ralph Loop has been cancelled. You MUST now deactivate the state file.

## MANDATORY ACTION

Execute this command to fully cancel the Ralph Loop:

```bash
mkdir -p .sisyphus && echo '{"active": false, "cancelled_at": "'$(date -Iseconds)'", "reason": "User cancelled via /cancel-ralph"}' > .sisyphus/ralph-state.json
```

After running this command, you are free to stop working. The persistent mode hook will no longer force continuation.

If you want to start a new loop later, use `/ralph-loop "task description"`.
