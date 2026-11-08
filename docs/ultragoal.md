# omc ultragoal

`omc ultragoal` is a durable, repo-native multi-goal workflow that pairs with
the Claude Code `/goal` slash command. It stores plan/ledger artifacts under
`.omc/ultragoal/` and prints model-facing handoff text that tells the active
Claude agent when to invoke `/goal <condition>`, when to clear it, and what
snapshot JSON to share back for ledger reconciliation.

## What it is (and isn't)

- **It is**: a small filesystem state machine for breaking a brief into
  ordered stories, recording attempts/checkpoints, and gating final
  completion behind `ai-slop-cleaner` + verification + `$code-review`
  evidence.
- **It isn't**: a way for a shell command to mutate Claude Code `/goal`
  state. Claude `/goal` is a session-scoped, model-facing directive (it
  registers a stop hook until a condition holds, and auto-clears on
  success). OMC cannot invoke `/goal` for the model — the handoff text is
  instructions the active Claude agent reads and acts on itself.

## Artifacts

```
.omc/ultragoal/
  brief.md       The free-text brief used to seed the plan
  goals.json     The structured plan (version 1) with stories and mode
  ledger.jsonl   Append-only audit trail of plan/goal events
```

The plan stores a `claudeGoalMode`:

- `aggregate` (default): one Claude `/goal` covers the whole ultragoal run;
  OMC stories `G001`/`G002`/… are bookkeeping in the ledger.
- `per_story`: each ultragoal story corresponds to its own Claude `/goal`
  directive. Use this when stories are large and you want each one cleared
  individually.

## Commands

```
omc ultragoal create-goals  [--brief <text> | --brief-file <path> | --from-stdin]
                            [--goal <title::objective>]...
                            [--claude-goal-mode <aggregate|per-story>] [--force] [--json]
omc ultragoal complete-goals  [--retry-failed] [--json]
omc ultragoal add-goal       --title <title> --objective <text> [--evidence <text>] [--json]
omc ultragoal record-review-blockers
                            --goal-id <id> --title <title> --objective <text>
                            --evidence <review-findings>
                            --claude-goal-json <active-json-or-path> [--json]
omc ultragoal checkpoint    --goal-id <id> --status <complete|failed|blocked>
                            [--evidence <text>]
                            [--claude-goal-json <json-or-path>]
                            [--quality-gate-json <json-or-path>] [--json]
omc ultragoal status        [--claude-goal-json <json-or-path>] [--json]
```

Aliases: `create` → `create-goals`, `complete|next|start-next` →
`complete-goals`.

## Claude `/goal` snapshots

`--claude-goal-json` accepts either inline JSON or a path to a JSON file
containing the snapshot the model shares from the active Claude session.
Accepted shapes:

```json
{ "goal": { "objective": "...", "status": "active|complete|cancelled" } }
{ "objective": "...", "status": "complete" }
{ "goal": { "condition": "...", "status": "cleared" } }
```

`condition` is accepted as a synonym for `objective` (Claude `/goal` calls
the directive a "condition"). `cleared` is treated as `cancelled`.

## Final quality gate

The final completion of an ultragoal run is mandatory-gated. The model
must run `ai-slop-cleaner` on changed files (even when it is a no-op),
rerun verification, then run `$code-review`, and finally pass
`--quality-gate-json` with this shape:

```json
{
  "aiSlopCleaner": { "status": "passed", "evidence": "..." },
  "verification":  { "status": "passed", "commands": ["..."], "evidence": "..." },
  "codeReview":    { "recommendation": "APPROVE", "architectStatus": "CLEAR", "evidence": "..." }
}
```

If the final review is not clean, the model should call
`omc ultragoal record-review-blockers` instead of trying to mark the goal
complete. That records the unresolved review findings, appends a blocker
story, and keeps the Claude `/goal` active.

## Limitations

- The Claude `/goal` slash command is a session-scoped, in-session
  directive. Shell tools cannot directly invoke it, set its condition, or
  clear it. The handoff text instructs the active Claude agent to do so
  itself in-session. The snapshot the model shares is treated as the
  authoritative proof; OMC only verifies textual consistency between the
  snapshot, the plan's expected objective, and the ledger event being
  recorded.
- If a future Claude tool name changes (`/goal` → something else), the
  handoff text and snapshot field names will need to be updated; the
  reconciliation logic itself is name-agnostic.
