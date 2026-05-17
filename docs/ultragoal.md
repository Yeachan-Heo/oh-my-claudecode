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

## When to Use Ultragoal vs Other Workflows

| Workflow | Scope | Persistence | Parallelism | Verification Gate | `/goal` Integration | Best For |
|----------|-------|-------------|-------------|-------------------|---------------------|----------|
| Claude `/goal` (bare) | Single session | None (session-scoped Stop hook) | No | No | Native | Quick single-session focus |
| `ralph` | Single task | Yes (`prd.json` + `progress.txt`) | Via `ultrawork` | Mandatory architect review | No | Guaranteed completion with verification |
| `team` | Multi-agent pipeline | Yes (staged state) | N coordinated agents | Per-stage verify/fix loop | No | Multi-component or many-task work |
| `ultraqa` | QA cycling | State file only | Diagnosis + fix | Cycle until pass | No | "Make tests/build/lint pass" |
| Stop hook (`code-simplifier`) | Per-turn trigger | None | No | Automatic | No | Background code hygiene |
| `omc ultragoal` (artifact-only) | Multi-goal brief | Yes (ledger + `goals.json`) | No | Mandatory quality gate (slop + verify + review) | Handoff text only | Large initiatives spanning sessions |

> The `/goal` evaluator is a session-scoped, model-facing directive. It
> cannot independently inspect files, run commands, or observe external state.
> `omc ultragoal` prints handoff text that the active Claude agent reads and
> acts on; it does not, and cannot, invoke `/goal` from the shell.

## Examples

### Issue backlog

```bash
omc ultragoal create-goals --brief "Close issues #101-#105" \
  --goal "Issue #101::Fix the reported regression and add evidence" \
  --goal "Issue #102::Implement the requested docs update"
omc ultragoal complete-goals
```

Use `ultragoal` instead of `ralph` when the issue set needs a durable ledger
and final quality gate across multiple sessions.

### Database migration

```bash
omc ultragoal create-goals --brief "Ship the migration" \
  --goal "Schema::Add new columns" \
  --goal "Backfill::Backfill rows in batches" \
  --goal "Cutover::Drop old columns and switch reads"
omc ultragoal status
```

Use `ultragoal` instead of `team` when the migration is ordered and stateful
rather than parallel across independent files.

### Test cleanup

```bash
omc ultragoal create-goals --brief "Fix flaky tests" \
  --goal "Isolate::Identify the flaky test sources" \
  --goal "Fix::Stabilize the tests and document evidence" \
  --goal "CI::Rerun the narrow CI-equivalent command"
omc ultragoal complete-goals --retry-failed
```

Use `ultragoal` instead of `ultraqa` when the cleanup spans several explicit
stories and needs an auditable final review gate.

### PRD implementation

```bash
omc ultragoal create-goals --brief-file prd.md --claude-goal-mode per-story
omc ultragoal complete-goals
```

Use per-story `ultragoal` when a PRD should survive session restarts and each
story should reconcile against its own Claude `/goal` handoff.

## Related Documentation

- [Artifact layout](./ultragoal.md#artifacts)
- [Claude `/goal` snapshot reconciliation](./ultragoal.md#claude-goal-snapshots)
- [Source boundary and evaluator limits](./ultragoal.md#limitations)
- [Workflow selection](./shared/mode-selection-guide.md)
- [Full skill instructions](../skills/ultragoal/SKILL.md)
