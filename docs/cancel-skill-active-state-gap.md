# Bug: cancel skill does not clear skill-active-state.json

## Summary

When `/oh-my-claudecode:cancel` is invoked, it clears mode state files for
ralph, ultrawork, autopilot, team, etc. — but it does **not** clear
`skill-active-state.json`. This causes the stop hook to keep firing
reinforcements after cancel until either the reinforcement limit or the stale
TTL expires.

## Reproduction

1. Invoke a `medium`-protected skill (e.g. `sciomc`, `learner`, `release`)
2. Before the skill completes, invoke `/oh-my-claudecode:cancel`
3. Observe: stop hook continues to block with `[SKILL ACTIVE: sciomc]`
   reinforcements 1/5 → 2/5 → ... until limit or 15-min TTL

## Root Cause

`skill-active-state.json` lives at:

```
.omc/state/sessions/{sessionId}/skill-active-state.json
```

The cancel skill calls `state_clear(mode=...)` for known modes, but the
`state_clear` MCP tool's mode enum does not include `skill-active`:

```
"autopilot" | "team" | "ralph" | "ultrawork" | "ultraqa"
| "ralplan" | "omc-teams" | "deep-interview"
```

No entry for `skill-active` → file is not deleted → stop hook reads stale
`active: true` and keeps blocking.

The skill protection registry (`src/hooks/skill-state/index.ts`) defines
`sciomc` as `medium`:

```typescript
sciomc: 'medium',  // 5 reinforcements, 15-min stale TTL
```

So the user is blocked for up to 15 minutes (or 5 hook fires) after cancel.

## Escape Valve (current workaround)

Delete the file manually:

```bash
rm .omc/state/sessions/<sessionId>/skill-active-state.json
```

Or wait for the 15-min TTL / 5-reinforcement limit to auto-clear it.

## Fix Options

### Option A — Add `skill-active` to the `state_clear` MCP tool

Add `"skill-active"` to the mode enum in the state tools so cancel can call:

```
state_clear(mode="skill-active", session_id=...)
```

### Option B — Cancel skill clears the file directly

In `skills/cancel/cancel.md` (the "No Active Modes" / force-clear section),
add a step:

```
After mode cleanup, also clear skill-active-state.json:
  state_clear(mode="skill-active", session_id)
```

Or via direct file deletion in the cancel script if state_clear doesn't
expose this mode.

### Option C — `/cancel` detection in skill-state stop hook

In `src/hooks/skill-state/index.ts`, check for a cancel-in-progress signal
before blocking, similar to how `cancelInProgress` is passed into
`checkUltrawork()`.

## Recommendation

Option A is the cleanest: it makes `skill-active` a first-class mode in the
state tooling, consistent with how other modes are managed. Option B is a
quick fix with no new infrastructure needed.

## Related

- `src/hooks/skill-state/index.ts` — protection registry + check logic
- `src/hooks/persistent-mode/index.ts:1170` — where skill state check is called
- `skills/cancel/cancel.md` — cancel skill cleanup steps
- Issue #1033 — original skill-state protection feature
- PR #2099 — fixes stale `awaiting_confirmation` for ralph/ultrawork/autopilot (different system)
