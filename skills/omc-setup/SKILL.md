---
name: omc-setup
description: Install or refresh oh-my-claudecode for plugin, npm, and local-dev setups from the canonical setup flow
level: 2
---

# OMC Setup

This skill is a **thin wrapper around `omc setup`**. It collects user
choices via AskUserQuestion, writes them to a temporary JSON file, asks
the CLI to materialize a validated preset, and then executes that preset.

All setup decision logic (phase ordering, validation, idempotency, state
machine) lives in the TypeScript CLI at `src/cli/index.ts` and
`src/setup/*.ts`. **Do not reimplement any of it here.**

**When this skill is invoked, immediately execute the workflow below. Do not only restate or summarize these instructions back to the user.**

**Path convention**: This guide uses `CONFIG_DIR` to refer to the Claude
config directory. Before presenting any path to the user, resolve it once
by running `echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"`. Use the resolved
value in all user-facing text — never display the literal `~/.claude`
unless that is the actual resolved path.

## Best-Fit Use

Choose this setup flow when the user wants to **install, refresh, or
repair OMC itself**.

- Marketplace/plugin install users should land here after `/plugin install oh-my-claudecode`
- npm users should land here after `npm i -g oh-my-claude-sisyphus@latest`
- local-dev and worktree users should land here after updating the
  checked-out repo and rerunning setup

## Step 1: Parse Flags

Check for flags in the user's invocation:

| Flag                | Behavior                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `--help`            | Show the Help Text (below) and stop.                                                            |
| `--preset <file>`   | Skip the wizard entirely. Run `omc setup --preset <file>` and report the result.                |
| `--local`           | Phase 1 only, local target. Run `omc setup --claude-md-only --local --overwrite`.               |
| `--global`          | Phase 1 only, global target. Run `omc setup --claude-md-only --global --overwrite`.             |
| `--force`           | Skip the "already configured" check and run the full wizard flow described in Step 3.          |
| (none)              | Run the full wizard flow described in Step 3.                                                   |

## Help Text

When user runs with `--help`, display this and stop:

```
OMC Setup — Configure oh-my-claudecode (thin wrapper around `omc setup`)

USAGE:
  /oh-my-claudecode:omc-setup                     Run interactive wizard (or update if already configured)
  /oh-my-claudecode:omc-setup --local             Configure local project (.claude/CLAUDE.md)
  /oh-my-claudecode:omc-setup --global            Configure global settings (CLAUDE.md in $CLAUDE_CONFIG_DIR or ~/.claude)
  /oh-my-claudecode:omc-setup --force             Skip the "already configured" gate and run the full wizard
  /oh-my-claudecode:omc-setup --preset <file>     Drive setup from a preset file (no prompts)
  /oh-my-claudecode:omc-setup --help              Show this help

All heavy lifting is delegated to the `omc setup` CLI. The skill only
collects answers via AskUserQuestion and hands them off as a JSON file.

For more info: https://github.com/Yeachan-Heo/oh-my-claudecode
```

## Step 2: Flag-Only Short-Circuits

Handle these three cases **before** any wizard prompting:

### `--preset <file>`

Run via the Bash tool:

```bash
omc setup --preset "<file>"
```

Report the exit code and any stderr to the user. **Stop.**

### `--local`

Run:

```bash
omc setup --claude-md-only --local --overwrite
```

Report the result. **Stop.**

### `--global`

Run:

```bash
omc setup --claude-md-only --global --overwrite
```

Report the result. **Stop.**

## Step 3: Wizard Flow

This path is taken when no flags (or only `--force`) were provided.

### 3.1 Check Setup State

Run:

```bash
omc setup --check-state
```

Parse the JSON output (one line on stdout). Fields:

- `alreadyConfigured: boolean`
- `setupVersion?: string` — present if config file exists
- `resumeStep?: number` — present if a previous run was interrupted

### 3.2 Already-Configured Gate

If `alreadyConfigured === true` **and** `--force` was NOT passed, use
AskUserQuestion:

**Question:** "OMC is already configured (version
`<setupVersion ?? 'unknown'>`). What would you like to do?"

**Options:**
1. **Update CLAUDE.md only** — Run `omc setup --claude-md-only --global --overwrite` and stop.
2. **Run full setup again** — Continue to 3.3.
3. **Cancel** — Exit without changes.

### 3.3 Resume Detection

If `resumeStep` was present in the `--check-state` output, use
AskUserQuestion:

**Question:** "Found a previous setup session at step
`<resumeStep>`. Resume or start fresh?"

**Options:**
1. **Resume from step `<resumeStep>`** — Just continue to 3.4 (the CLI
   will pick up the saved state automatically).
2. **Start fresh** — First run `omc setup --state-clear`, then continue
   to 3.4.

### 3.4 Collect Answers

Walk the user through AskUserQuestion prompts — **one question per
field**. The canonical source of question text + options is
`QUESTION_METADATA` in `src/setup/options.ts`. Use the field IDs listed
here; copy the question text and option labels from `QUESTION_METADATA`
verbatim so text stays in sync with the TypeScript source.

Collect these fields (in order):

1. `target` — `local` | `global`
2. `installStyle` — `overwrite` | `preserve` (only if `target === 'global'`)
3. `executionMode` — `ultrawork` | `No default` (stored as `ultrawork` or omitted)
4. `installCli` — `true` | `false`
5. `taskTool` — `builtin` | `bd` | `br`
6. `mcpEnabled` — `true` | `false` (just the gate — MCP credential collection is the `mcp-setup` skill's job)
7. `teamsEnabled` — `true` | `false`
8. `teamsDisplayMode` — `auto` | `in-process` | `tmux` (only if `teamsEnabled`)
9. `teamsAgentCount` — `2` | `3` | `5` (only if `teamsEnabled`)
10. `teamsAgentType` — `executor` | `debugger` | `designer` (only if `teamsEnabled`)
11. `starRepo` — `true` | `false`

### 3.5 Write Answers File

Build an `AnswersFile` JSON object (schema lives in
`src/setup/preset-builder.ts`):

```json
{
  "target": "local",
  "installStyle": "overwrite",
  "executionMode": "ultrawork",
  "installCli": true,
  "taskTool": "builtin",
  "mcp": { "enabled": false },
  "teams": { "enabled": true, "displayMode": "auto", "agentCount": 3, "agentType": "executor" },
  "starRepo": false
}
```

Write it to a temporary file:

```bash
ANSWERS_FILE="$(mktemp -t omc-answers.XXXXXX.json)"
PRESET_FILE="$(mktemp -t omc-preset.XXXXXX.json)"
chmod 0600 "$ANSWERS_FILE" "$PRESET_FILE"
# …write the JSON to $ANSWERS_FILE…
```

> **Cleanup is mandatory.** Always remove `$ANSWERS_FILE` and
> `$PRESET_FILE` after the run completes, whether it succeeded or
> failed. Use `trap` or an equivalent finally-style block so the temp
> files never leak.

### 3.6 Build the Preset

```bash
omc setup --build-preset --answers "$ANSWERS_FILE" --out "$PRESET_FILE"
```

This validates the answers, expands them into a full `SetupOptions`, and
writes the preset JSON to `$PRESET_FILE`. Any validation failure (e.g.
`teams.agentCount` not in `{2,3,5}`) exits non-zero with a red error on
stderr — surface that error to the user and stop.

### 3.7 Run the Preset

```bash
omc setup --preset "$PRESET_FILE"
```

This executes every phase the preset requests (claude-md, infra,
integrations, welcome — and, when applicable, the mcp-only sub-phase).
Surface stdout/stderr and the exit code to the user.

### 3.8 Cleanup

```bash
rm -f "$ANSWERS_FILE" "$PRESET_FILE"
```

Run cleanup **on both success and failure** paths.

## Graceful Interrupt Handling

If the `omc setup --preset` run is interrupted, the CLI's own state
machine persists progress via `omc setup --state-save <step>`. The next
invocation of this skill will detect it in Step 3.1 and offer a resume.

## Keeping Up to Date

After installing oh-my-claudecode updates (via npm or plugin update):

- Re-run `/oh-my-claudecode:omc-setup` — the "already configured" gate
  offers a one-click CLAUDE.md update without re-running the wizard.
- Or jump straight to the targeted flag: `--local`, `--global`, or
  `--force`.
