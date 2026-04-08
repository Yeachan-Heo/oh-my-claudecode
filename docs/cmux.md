# cmux Integration

OMC natively supports [cmux](https://cmux.dev) (a Ghostty-based Mac terminal) for team worker spawning. When running inside a cmux surface, `omc team` workers appear as native cmux tabs or splits instead of a detached tmux session.

## Requirements

- cmux 0.61.0 or later
- `CMUX_SURFACE_ID` environment variable set (automatic inside cmux surfaces)

## How detection works

1. OMC checks `$TMUX` first — if set, tmux is used (tmux takes priority).
2. If `$CMUX_SURFACE_ID` is set, OMC tries the cmux driver.
3. The driver verifies the cmux CLI is available and version ≥ 0.61.0.
4. On any failure, OMC falls back to a detached tmux session (same as before this feature existed).

## Layout modes

Set `OMC_CMUX_LAYOUT` to control how workers appear:

| Value | Behavior |
|---|---|
| `tab` (default) | New vertical tab in the sidebar per worker |
| `split-right` | Split the current surface horizontally, workers on the right |
| `split-down` | Split the current surface vertically, workers below |
| `split-left` | Workers split to the left |
| `split-up` | Workers split above |

Short aliases are accepted: `right`, `down`, `left`, `up`, `tabs`.

Example:
```bash
export OMC_CMUX_LAYOUT=split-right
omc team 3:executor "implement the feature"
```

## Forcing tmux fallback

If you want to bypass the cmux driver and use a detached tmux session:

```bash
unset CMUX_SURFACE_ID
omc team ...
```

Or downgrade to cmux < 0.61 (the driver will refuse and fall back automatically).

## CLI resolution

The driver searches for the `cmux` CLI binary in this order:

1. `cmux` on `$PATH` (set by cmux shell integration in interactive shells)
2. `${GHOSTTY_BIN_DIR}/../Resources/bin/cmux`
3. `/Applications/cmux.app/Contents/Resources/bin/cmux`

## Session names

cmux-backed team sessions use the prefix `cmux:` in their session name (e.g., `cmux:workspace:1`). This lets OMC distinguish cmux surfaces from tmux panes when routing commands like `sendToWorker` and `capturePaneAsync`.

## Existing tmux workflows

All existing tmux-based workflows are completely unchanged. The cmux driver only activates when `$CMUX_SURFACE_ID` is set and `$TMUX` is not.
