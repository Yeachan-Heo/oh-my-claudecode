---
description: Cancel active Ecomode mode (deprecated - use /oh-my-claudecode:cancel instead)
---

# Cancel Ecomode

[ECOMODE CANCELLED]

**DEPRECATION NOTICE:** This command is deprecated. Use `/oh-my-claudecode:cancel` instead, which intelligently detects and cancels any active mode including ecomode.

The unified cancel command is safer because it:
- Checks if ecomode is linked to Ralph and handles both
- Prevents orphaned state files
- Provides consistent cancellation experience

## Legacy Behavior

If you still use this command, it will:

1. Check if ecomode is linked to Ralph
2. If linked → Warn and suggest using `/oh-my-claudecode:cancel-ralph`
3. If standalone → Cancel ecomode only

## Arguments

{{ARGUMENTS}}

## Recommended Action

Use the unified cancel command:
```
/oh-my-claudecode:cancel
```

This will detect ecomode and cancel it properly, along with any linked modes.

## Implementation

If you must cancel ecomode directly:

```bash
# Check if linked to ralph
LINKED=$(cat .omc/ecomode-state.json 2>/dev/null | jq -r '.linked_to_ralph // false')

if [[ "$LINKED" == "true" ]]; then
  echo "Warning: Ecomode is linked to Ralph."
  echo "Use /oh-my-claudecode:cancel to cancel both modes."
  exit 1
fi

# Cancel standalone ecomode
mkdir -p .omc ~/.claude
rm -f .omc/ecomode-state.json
rm -f ~/.claude/ecomode-state.json

echo "Ecomode cancelled. Token-efficient execution mode deactivated."
```

## Migration

Replace:
```bash
/oh-my-claudecode:cancel-ecomode
```

With:
```bash
/oh-my-claudecode:cancel
```

The new unified cancel is smarter and safer.
