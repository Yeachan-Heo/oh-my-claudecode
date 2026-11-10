# Hooks System

> OMC's 21 hooks intercept Claude Code lifecycle events to enable magic keywords, context injection, and quality enforcement.

## What Are Hooks?

Hooks are scripts that execute automatically in response to Claude Code lifecycle events. oh-my-claudecode extends Claude Code's default behavior with 21 hooks.

When a user submits a prompt, a tool runs, or a session starts/ends, hooks fire automatically to inject additional context, activate modes, and manage state.

## How Hooks Work

Hooks are defined in a `hooks.json` file. Each hook follows this structure:

```json
{
  "EventName": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "node",
          "args": [
            "${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs",
            "${CLAUDE_PLUGIN_ROOT}/scripts/hook-script.mjs"
          ],
          "timeout": 5
        }
      ]
    }
  ]
}
```

- **EventName**: The lifecycle event the hook responds to
- **matcher**: Condition for running the hook (`*` matches all cases)
- **command**: The program to spawn. Published plugin hooks use `node`
- **args**: Arguments passed to that program. The first is `run.cjs`; the second is the hook script
- **timeout**: Maximum execution time in seconds

Published plugin hooks use exec form: `command` is `node` and `args` names `scripts/run.cjs` plus the hook script. Claude Code and Grok substitute `${CLAUDE_PLUGIN_ROOT}` inside each arg and spawn `node` with no shell, so a plugin root that contains spaces stays one argument. A host that ignores `args` and runs `command` as a shell string would start bare `node`, and the hook would miss its script. `find-node.sh` remains for the HUD and for repairing older Unix caches whose non-interactive PATH does not include `node`.

Hook output is injected into Claude via `<system-reminder>` tags. Additional context is passed through `hookSpecificOutput.additionalContext`.

## Hook Categories

OMC hooks fall into four categories:

### Core Hooks

Handle orchestration, keyword detection, and mode persistence.

| Hook | Description |
|------|-------------|
| keyword-detector | Detects magic keywords and activates corresponding skills |
| persistent-mode | Enforces continuation when an execution mode (ralph, autopilot, team, etc.) is active — injects reinforcement messages on Stop to prevent premature halting |

### Context Management Hooks

Manage memory, project state, and compaction.

| Hook | Description |
|------|-------------|
| notepad | Compaction-resistant memory system |
| project-memory | Manages project-level memory |
| pre-compact | Processes state before compaction |

### Quality / Verification Hooks

Handle code quality, permissions, and subagent tracking.

| Hook | Description |
|------|-------------|
| permission-handler | Handles permission requests and validation |
| subagent-tracker | Tracks subagent spawn and completion |
| code-simplifier | Auto-simplifies recently modified files on Stop (opt-in) |
| workflow-drift-guard | Blocks only closed, local Stop-hook selection forks with two known-live alternatives and unchanged fake-completion blockers |

## Disabling Hooks

### Disable All Hooks

```bash
export DISABLE_OMC=1
```

### Disable Specific Hooks

```bash
export OMC_SKIP_HOOKS="keyword-detector,notepad"
```

Separate hook names with commas to skip only those hooks.

---

## Lifecycle Events

Claude Code emits events throughout a session. OMC attaches hooks to these events to extend behavior. There are 11 lifecycle events.

### UserPromptSubmit

Fires when the user submits a prompt.

| Script | Role | Timeout |
|--------|------|---------|
| `keyword-detector.mjs` | Detects magic keywords and invokes the corresponding skill | 30s outer host fuse; 8s trusted Worker limit |
| `skill-injector.mjs` | Injects skill prompts | 30s outer host fuse; 12s trusted Worker limit |

Runs on all user input (`matcher: "*"`). When the keyword detector finds keywords like "ralph" or "autopilot", it injects the corresponding skill invocation instruction via `additionalContext`. Parallel work is invoked explicitly with `/oh-my-claudecode:team` and is not auto-detected.

The 30s timeout is a per-command outer host fuse that includes launcher startup before `run.cjs`. Once the runner reaches its exact trusted Worker branch, `keyword-detector.mjs` is limited to 8s and `skill-injector.mjs` to 12s; lower manifest limits are never extended. A command that never reaches `run.cjs` can consume its full 30s outer fuse. The host schedules the two commands externally, so this does not claim an aggregate prompt latency.

### SessionStart

Fires when a new session begins.

| Script | Matcher | Role | Timeout |
|--------|---------|------|---------|
| `session-start.mjs` | `*` | Session initialization, state restoration | 5s |
| `project-memory-session.mjs` | `*` | Loads project memory | 5s |
| `setup-init.mjs` | `init` | Initial setup wizard | 30s |
| `setup-maintenance.mjs` | `maintenance` | Maintenance tasks | 60s |

The `init` and `maintenance` matchers only run in special cases. For normal session starts, only the two `*` matcher scripts execute.

### PreToolUse

Fires immediately before Claude uses a tool.

| Script | Role | Timeout |
|--------|------|---------|
| `pre-tool-enforcer.mjs` | Validates rules before tool use | 60s |

Runs on all tool calls (`matcher: "*"`). Enforces agent permission restrictions (e.g., blocking Write/Edit for read-only agents).
Denies Task/Agent calls whose `subagent_type` names a bundled skill (issue #3667): instead of Claude Code's generic native "Agent type not found", the hook returns a precise error naming the Skill tool and the correct identifier, and forbids closest-match agent substitution.
The exact canonical shipped script runs in the trusted Worker path; untrusted paths, event mismatches, and extra arguments retain the isolated child-process fallback.
With `OMC_SHELL_CHECKS=1` it also checks Bash and PowerShell commands before they run (see [Shell Checks](#shell-checks-scriptslibshell-checksmjs)).

### PermissionRequest

Fires when a permission request arises during Bash tool execution.

| Script | Matcher | Role | Timeout |
|--------|---------|------|---------|
| `permission-handler.mjs` | `Bash` | Handles Bash command permissions | 5s |

Only processes permission requests for the Bash tool.

### PostToolUse

Fires after a tool use completes.

| Script | Role | Timeout |
|--------|------|---------|
| `post-tool-verifier.mjs` | Verifies tool results and injects additional context | 10s |
| `project-memory-posttool.mjs` | Updates project memory | 3s |
| `post-tool-rules-injector.mjs` | Injects matching project rules | 3s |
| `post-tool-directory-context-injector.mjs` | Injects the README.md and AGENTS.md files from the file's directory up to the working directory, for Read, Write, Edit, and MultiEdit | 3s |

Injects additional guidance based on Read, Write, Edit, and Bash results. For example, after reading a file it may hint "consider using parallel reads."
These exact canonical shipped scripts use the trusted Worker path without changing their manifest timeout budgets. The verifier retains statistics for the current session and the 99 most recently updated historical sessions so per-tool writes stay bounded. With `OMC_SHELL_CHECKS=1`, `post-tool-verifier.mjs` also records known shell error classes of Bash and PowerShell results (see [Shell Checks](#shell-checks-scriptslibshell-checksmjs)). Disable all four with `DISABLE_OMC=1` (or `DISABLE_OMC=true`) or `OMC_SKIP_HOOKS=post-tool-use`; `project-memory-posttool` also accepts its script-specific token.

### PostToolUseFailure

Fires when a tool use fails.

| Script | Role | Timeout |
|--------|------|---------|
| `post-tool-use-failure.mjs` | Provides recovery guidance for failed tool use | 3s |

With `OMC_SHELL_CHECKS=1`, the script also records known shell error classes of failed Bash and PowerShell calls (see [Shell Checks](#shell-checks-scriptslibshell-checksmjs)).

Disable via `DISABLE_OMC=1` (or `DISABLE_OMC=true`) or `OMC_SKIP_HOOKS=post-tool-use-failure` (the `post-tool-use` token also skips it, alongside `post-tool-verifier.mjs`).

### SubagentStart

Fires when a subagent is spawned.

| Script | Role | Timeout |
|--------|------|---------|
| `subagent-tracker.mjs start` | Tracks subagent start, injects prompts | 3s |

Records the subagent name, start time, and session information.

### SubagentStop

Fires when a subagent completes.

| Script | Role | Timeout |
|--------|------|---------|
| `subagent-tracker.mjs stop` | Tracks subagent completion | 5s |
| `verify-deliverables.mjs` | Verifies subagent deliverables | 5s |

### PreCompact

Fires immediately before context compaction.

| Script | Role | Timeout |
|--------|------|---------|
| `pre-compact.mjs` | Preserves state before compaction | 10s |
| `project-memory-precompact.mjs` | Preserves project memory | 5s |

Saves important state and memory before compaction runs because the context window is full. The checkpoint captures active mode states, TODO counts, background job status, and durable plan anchors (PRD/boulder references). After compaction, the `SessionStart` hook (`source: "compact"`) restores the newest matching checkpoint into context so OMC-owned plan detail survives compaction (issue #3730).

### Stop

Fires when Claude finishes a response.

| Script | Role | Timeout |
|--------|------|---------|
| `context-guard-stop.mjs` | Monitors context usage | 5s |
| `workflow-drift-guard.mjs` | Blocks narrow structured-question and fake-completion drift | 3s |
| `persistent-mode.mjs` | Maintains active mode state (ralph, team, etc.) | 20s |
| `code-simplifier.mjs` | Auto-simplifies modified files (opt-in) | 10s |

`persistent-mode` injects a reinforcement message like "The boulder never stops" when an active execution mode is running, prompting continued work. A fresh unconfirmed ultragoal is exempt while Claude `/goal` confirmation is pending; confirmed runs remain fail-closed.

### SessionEnd

Fires when a session ends.

| Script | Role | Timeout |
|--------|------|---------|
| `session-end.mjs` | Saves session summary, sends callback notifications | 30s |

Saves agent activity, token usage, and other session data to `.omc/sessions/`. If configured, sends completion notifications via Discord, Telegram, or Slack.

---

## Core Hooks

### Core Hook Details

#### keyword-detector

Detects magic keywords in user prompts and invokes the corresponding skill.

- **Event**: UserPromptSubmit
- **Behavior**: Sanitizes the prompt (removes code blocks, URLs, file paths) then matches keyword patterns
- **Conflict resolution**: cancel has highest priority, then ralph > autopilot

- **Safety**: Disabled inside team workers to prevent infinite spawning

See the [Magic Keywords](#magic-keywords) section for the full keyword list.

#### workflow-drift-guard

Blocks only deterministic recurring workflow drift at the Claude Code `Stop` lifecycle point. The boundary follows the official Claude Code [hooks reference](https://code.claude.com/docs/en/hooks): Stop hooks receive `last_assistant_message`, may return `decision: "block"` with a `reason`, and must account for `stop_hook_active` to avoid self-reinforcing loops. Plugin/Hookify installs follow the official Claude Code [plugins reference](https://code.claude.com/docs/en/plugins-reference): plugin hooks can live in `hooks/hooks.json` at the plugin root and respond to the same lifecycle events as user hooks.

- **Event**: Stop
- **Behavior**: Blocks only a supported, local selection fork in the final assistant message. The block reason directs Claude to use `AskUserQuestion` with 2–4 options and `allowOther` unless free-form input is unsafe.
- **Fake completion guard**: Unchanged. It blocks only when the final assistant message claims completion and changed code adds deterministic blockers (`test.skip`/`.only`, placeholder TODOs, unimplemented throws, placeholder returns, or explicit stub/placeholder implementations).

##### Closed selection evidence

The decision classifier is stateless and final-message-local. `last_assistant_message` takes precedence; only when it is absent does it use `lastAssistantMessage`, `message`, `output`, `response`, then `text`. It does not use transcript content, prior `AskUserQuestion` calls, firing history, counters, cooldowns, or session state. It masks recognized non-prose before extracting the final unmasked question and blocks only when exactly one of these three source-associated evidence forms independently establishes selection intent and at least two known-live alternatives:

1. **Direct binary question**: either a bare `<single name> or <single name>?` with exactly one top-level ASCII ` or ` delimiter, `Would you prefer <1–6-token named operand> or <1–6-token named operand>?`, `Do you prefer <1–6-token named operand> or <1–6-token named operand>?`, or `Should I <1–8-token action operand> or <1–8-token action operand>?`. Unsupported prefixes, polarity/auxiliary forms, duplicate alternatives, multiple delimiters, or `and`/`or` grouping are not inferred.
2. **One exact adjacent setup plus one selection closer**: the final question must immediately follow exactly one supported setup sentence and use an exact closer: `Which [option|approach|path|one] should I [choose|use|take]?` or `Which should I [choose|use|take]?`. A named setup enumerates exactly two (`C and C`), three (`C, C, and C`), or four (`C, C, C, and C`) candidates. Its `ENUMERATION` core ends in exactly `are viable options`, `are viable`, `are options`, or `were considered`. The full setup is then exactly `<ENUMERATION>.`, `<ENUMERATION>; <C> is|was <status>[ and <C> is|was <status>].`, `<ENUMERATION>; only <C> remains.`, `<ENUMERATION>; the other module is unchanged.`, `<ENUMERATION>, or <paste|provide|enter> the exact <operand>.`, or `<ENUMERATION>, or describe <operand>.` Named liveness statuses are exactly `ruled out`, `eliminated`, `discarded`, `not viable`, `no longer an option`, `already chosen`, `already selected`, and `already resolved`. A named candidate is 1–4 exact `NAME_TOKEN`s (`[A-Za-z0-9][A-Za-z0-9._/+:-]*`) separated by one ASCII space, after at most one balanced outer emphasis pair is removed. The parser enumerates every full-string syntactic parse before normalization; zero or multiple parses pass. Only after one parse is established are normalized duplicate identities collapsed, and only compatible states may merge—conflicting duplicate states are unknown and pass.
3. **One exact contiguous option list plus one selection closer**: at least two supported `- `, `* `, `+ `, numeric (`1.`–`9.`), or alphabetic (`A.`–`Z.`/`a.`–`z.`) items must be contiguous and directly followed by that closer; blank lines are allowed only between items. Items may use only the exact eliminated-status suffixes `ruled out`, `eliminated`, `discarded`, `not viable`, or `no longer an option`, in an em-dash or parenthesized form. Any other marker, suffix, or intervening non-item prose passes.

All candidate-bearing records use the same rules. Empty candidates and exact `this`, `that`, `it`, `something`, `yes`, `no`, and `not` do not count; valid candidates start live; exact supported statuses can eliminate them; and exact `only C remains` keeps that candidate live while eliminating its named peers. A record blocks only with at least two unique, substantive, known-live identities after compatible duplicate collapse. An unlinked, ambiguous, conflicting, or unknown candidate state passes.

An offered candidate normalized exactly as `other` or `other/free-form` always takes precedence and makes its binary, named-setup, or list record pass. The named-setup free-form productions (`or paste`, `provide`, or `enter the exact …`, or `describe …`) also pass. Conversely, the exact local suffix `; the other module is unchanged.` is ignored non-evidence: it neither supplies an alternative nor triggers the `Other` escape.

Cardinality is candidate-free: exact `I found two viable [paths|options|approaches].`, `There are two viable [paths|options|approaches].`, and `Two viable [paths|options|approaches] remain.` setups establish a minimum of two live alternatives when directly paired with a selection closer. The only reduction is the exact matching-noun sentence `<I found|There are> two viable <plural>, but one <singular> <is|was> <status>.`; its status may be `ruled out`, `eliminated`, `discarded`, `not viable`, `no longer an option`, `resolved`, `already chosen`, `already selected`, or `already resolved`, including `was resolved`. That makes cardinality unknown and passes unless the exact matching-noun re-establishment sentence `One <singular> <is|was> <status>; two viable <plural> remain.` restores two. `Only one path|option|approach remains.` creates no cardinality evidence. The guard never invents candidate names from cardinality.

Ambiguous-regex and malformed-ternary uncertainty is bounded to the current physical line using half-open UTF-16 source ranges. Uncertainty intersecting or following a record passes; uncertainty ending before the record does not suppress it. Unlisted syntax, malformed or overlapping parses, unsupported open-input wording, uncertain boundaries, and any attempt to combine candidates, cardinality, liveness, intent, or free-form evidence across records all fail open.

- **Unchanged pass behavior**: Free-form/`Other` cases, TODO/stub markers without a completion claim, `stop_hook_active` re-entry, environment skips, and exception handling fail open as before.
- **Minimal safe boundary**: Worktree/session continuity remains SessionStart guidance plus existing mode-state restoration because a generic Stop hook cannot safely infer that the assistant is in the wrong branch or has lost context without overblocking valid work.

#### persistent-mode

Enforces continuation when an execution mode is active. This is the hook that keeps skills like autopilot, ralph, and team running.

- **Event**: Stop
- **Behavior**: Checks `.omc/state/` for active mode state files. If any current mode (ralph, ultragoal, autopilot, team) or legacy/retired state (ultrawork, pipeline) is active, injects a reinforcement message to prevent Claude from stopping.

- **Reinforcement message**: "The boulder never stops" — prompts Claude to continue working
- **Staleness check**: States older than 2 hours are treated as inactive to prevent stale state from blocking new sessions
- **Notification**: Sends Discord/Telegram/Slack notification on first stop (if configured)
- **Cancel**: Use `/oh-my-claudecode:cancel` to deactivate modes

> **Note**: autopilot, ralph, and team are **skills** (invoked through their current skill surfaces), not hooks. Legacy/retired `ultrawork` and `pipeline` state is cleanup-only and must never be invoked or reactivated. The persistent-mode hook enforces continuation by blocking the Stop event.

#### budget-guard (`budget-guard.mjs`)

Enforces `OMC_RUN_BUDGET_TOKENS` for unattended sessions: when an active unattended mode (ralph, autopilot, team, ultragoal) is running and the session's token spend crosses the budget, the hook blocks the Stop event and sends the model back to finish with a resumable budget report.

On a Stop re-entry (`stop_hook_active` or `stopHookActive`), it records a pass and never blocks again, avoiding a self-reinforcing loop.

- **Event**: Stop
- **Token accounting**: sums the latest usage snapshot for each assistant message in a bounded tail (2 MB) of the session transcript, including cache tokens. Repeated records are deduplicated by `message.id`, falling back to `requestId`; records without either ID are counted individually. The bounded tail can undercount a long session. A missing or unreadable transcript degrades to a logged pass; the hook never blocks on absent evidence.
- **Rollout (tri-state, mirrors the jev off/shadow/active protocol)**: `OMC_BUDGET_ENFORCE=off` does nothing; `shadow` (default) logs judgments to `.omc/state/enforcement/shadow.jsonl` and never blocks or warns; `active` warns at 90% (system message) and blocks at 100% (exit 2, budget-report contract in the refusal).
- **Evidence**: every judgment is appended to the shadow log (`{ts, rule, mode, outcome, detail, latencyMs}`) — the promotion evidence for moving the default from shadow to active. A rule promotes only after enough samples with zero false blocks.

### Mode State Management

Execution mode hooks manage state files in the `.omc/state/` directory.

```json
{
  "active": true,
  "started_at": "2025-01-15T10:30:00Z",
  "prompt": "ralph implement auth",
  "session_id": "abc123",
  "project_path": "/path/to/project",
  "iteration": 0,
  "max_iterations": 10,
  "linked_ultrawork": false,
  "last_checked_at": "2025-01-15T10:30:00Z"
}
```

The `linked_ultrawork` field is a legacy state field retained for compatibility with retired state files; it is not an invocable mode.

When a session ID is present, state is stored in session scope under `.omc/state/sessions/{sessionId}/`.

#### ultragoal-state.json lifecycle

`ultragoal-state.json` is the session-scoped Stop/PreToolUse guard for `$ultragoal` runs. The durable plan and audit trail remain `.omc/ultragoal/goals.json` and `.omc/ultragoal/ledger.jsonl`; the state file only records the active runtime guard.

- **Location**: `.omc/state/sessions/{sessionId}/ultragoal-state.json` when a Claude session id is available; legacy fallback is `.omc/state/ultragoal-state.json`.
- **Active fields**: `active: true`, `session_id`, `project_path`, `started_at`, `last_checked_at`, `current_phase`, optional `claude_goal_objective`, `reinforcement_count`, `awaiting_confirmation`, and `awaiting_confirmation_set_at`.
- **Pending confirmation**: a fresh unconfirmed state is exempt from both Stop reinforcement and matching-`/goal` PreToolUse enforcement. Freshness requires `awaiting_confirmation: true` and a timestamp age in `[0, 2 minutes)`; a non-empty `awaiting_confirmation_set_at` is authoritative, while an absent or blank value may fall back to `started_at`. Invalid, future, or expired timestamps fail closed.
- **Stop hook**: after confirmation, reinforces only when the state is active, fresh (within the normal 2-hour mode-state freshness window), session-matching, and project-matching. Terminal phases (`complete`, `completed`, `done`, `all-done`, `failed`, `cancelled`) and all-done `.omc/ultragoal/goals.json` plans are ignored.
- **PreToolUse guard**: after confirmation, tools are denied unless the hook can see a matching active Claude `/goal` snapshot. Use `ALLOW_ULTRAGOAL_WITHOUT_GOAL=1` only as an intentional local bypass.
- **Completion**: after the final quality gate and ultragoal checkpoint, mark the state inactive or run `/oh-my-claudecode:cancel` so the state file is cleared with other workflow state.

#### Canceling a Mode

```
cancelomc
```

or

```
/oh-my-claudecode:cancel
```

`cancel` removes state files for all active modes: ralph, autopilot, team, and any others; it also clears legacy/retired `ultrawork` state.

#### Git Guardrails (`git-guardrails.mjs`)

A PreToolUse hook (matcher: `Bash`) that checks shell command positions and blocks destructive Git operations from agent-driven Bash calls with an authority message. It scans commands separated by shell chains and newlines, so a destructive command is still blocked when it follows a safe command. Quoted arguments and ordinary text commands such as `echo git push` are not mistaken for Git invocations. Git's global options before the subcommand are skipped, including `-C <dir>`, `-c key=value`, `--git-dir`/`--work-tree` (in `=` or separate-word form), `--no-pager`/`-P`, and the other flags `git help git` lists, so `git --no-pager push` is blocked like `git push`.

- **Enable**: Set `OMC_GIT_GUARDRAILS=1` to enable in any session. The guard also auto-enables when the canonical state resolver finds an active ralph, autopilot, team, or ultragoal state owned by the current session. If the payload has no session ID, auto-enable fails open rather than borrowing another session's legacy state. `OMC_GIT_GUARDRAILS=0` disables both activation paths; otherwise the hook fails open when no active mode is found.
- **Blocked operations**: non-dry-run `git push`, `git reset --hard`, non-dry-run `git clean -f/--force`, forced branch deletion (`git branch -D`, `-d --force`, or `--force --delete` in either order), and `git checkout .` / `git checkout -- .` or `git restore .` (working-tree discard). The hook ignores Git option-looking arguments after `--`; those are refspecs or pathspecs, not options.
- **Safe operations**: `git push --dry-run` / `git push -n`, clean dry-runs (`git clean -n`, including `git clean -n -- -f`), soft resets, non-forced branch deletes (`-d`), and path-specific checkout/restore commands such as `git checkout ./path` and `git restore ./file` pass. Malformed, absent, or command-less payloads fail open. An unset guard variable outside an active mode also fails open after a bounded stdin read; explicit `=0` exits before reading stdin.
- **Message**: the hook refuses with “You do not have authority for this operation” and names the two legitimate exits — the user runs it themselves, or explicitly sets `OMC_GIT_GUARDRAILS=0`. When auto-enabled by an active mode, the refusal names the mode.
- **Prove it bites**: before trusting the guardrail in a session, feed it a planted violation once and watch it block (see the `refit` skill's landing rule). An installed guardrail nobody has seen fire is decoration, not protection.

#### Shell Checks (`scripts/lib/shell-checks.mjs`)

Opt-in checks of Bash and PowerShell commands, run by `pre-tool-enforcer.mjs` before the rest of the hook, plus a log of the shell errors that still happen. Set `OMC_SHELL_CHECKS=1` to enable. Without it no hook imports the module and the hooks behave exactly as before. Every check is fail-open: if the module throws, the command runs as if the checks did not exist, and the hook never returns `ask`.

The checks exist because some failures of the Bash tool are silent or misleading. On Windows the Bash tool passes the command to Git Bash as the argument of `bash -c`, inside a wrapper of about 460 characters in which every `'` becomes `'"'"'`. Git Bash cuts that argument after about 8190 characters, so the tail of a long command (usually a heredoc written by an agent) is lost: the result is `unexpected EOF while looking for matching`, or a silently shortened here-document. Git Bash also halves runs of backslashes in the command text (`\\` becomes `\`) except right before a `"`, and bash 5.3.15 in Git for Windows 2.55.0 fails to parse some `$'\r'` constructs inside `"$(...)"`.

| Check | Platforms | Result | What it catches |
|-------|-----------|--------|-----------------|
| `length` | Windows | deny | `characters + 4 x apostrophes + 460` is 7700 or more. The message says to write the script to a file and run it with a short command, or to pass the script to bash on stdin. |
| `cr-parser` | Windows | deny | In one top-level `"..."`, a `$(...)` or `${...}` with a CR-producing `$'...'` (`\r`, `\015`, `\x0d`, `\cM`, `\u000d`) after another `$(...)`. The message names replacements such as `grep -c -P '\r$'`. `bash -n` does not see this bug. |
| `syntax` | all | deny | `bash -n` on the command (stdin, 1 s limit) exits 2 with a parser message. On Windows the text checked is the one Git Bash will see after halving backslashes, and only commands longer than 200 characters are checked, because `bash -n` costs about 110 ms there (p95 about 500 ms). On macOS only a Homebrew bash is used, since `/bin/bash` 3.2 rejects bash 4 syntax; without one the check is skipped. A crashed `bash` or a timeout never denies. |
| `heredoc` | all | deny | A here-document without its closing line (`bash -n` only warns and exits 0). |
| `backslash` | Windows | warn | A run of two or more backslashes not directly before `"`. |
| `ps-ssh-dollar` | all | warn | PowerShell: `ssh` with `\$` inside `"..."` (`\$` is no escape in PowerShell, so the expansion happens locally). |
| `ps-dev-null` | Windows | warn | PowerShell: `2>/dev/null` outside quotes (it writes to `C:\dev\null`; use `2>$null`). |

A denial is a PreToolUse `permissionDecision: "deny"` whose reason starts with `[SHELL CHECK]`. A warning is added to `additionalContext`, in front of whatever other context the hook emits for that call, and is never added to a denial.

- **Log**: `<state root>/state/shell-checks/checks.jsonl` has one row per Bash or PowerShell command (decision, checks run, length, `bash -n` time, session and tool-use ids and `cwd`; the command text only for a denial, at most 300 characters, after masking secrets). `errors.jsonl` has one row for each tool result that shows a known shell error class (`unexpected-eof`, `heredoc-eof`, `enametoolong`, `python-invalid-escape`, `win-path-not-found`, `ps-missing-terminator`, `ps-dev-null`; for the first two a `cause` of `truncation`, `parser-bug` or `manual`), written by `post-tool-verifier.mjs` and `post-tool-use-failure.mjs`. A file above 50 MB is renamed with a timestamp and the newest two such files are kept.
- **Measured on**: Claude Code 2.1.318 and Git for Windows 2.55.0 (`bash.exe` 5.3.15). The wrapper size and the cut point belong to those programs, so re-check them after updating either (`printf '%s' "$BASH_EXECUTION_STRING"` shows the wrapper).

| Variable | Default | Description |
|----------|---------|-------------|
| `OMC_SHELL_CHECKS` | (unset) | `1` enables the checks and the error log. Any other value leaves everything off. |
| `OMC_SHELL_CHECKS_LENGTH_LIMIT` | `7700` | Effective length from which `length` denies on Windows (1000-100000; other values use the default). |
| `OMC_SHELL_SYNTAX_TIMEOUT_MS` | `1000` | Time limit of the `bash -n` check in milliseconds (100-3000, so that a hung `bash` cannot use up the hook timeout; other values use the default). |
| `OMC_SHELL_CHECKS_LOG_DIR` | `<state root>/state/shell-checks` | Log directory override. |

#### Stale Run Reporter (`stale-run-reporter.mjs`)

A SessionStart hook: the unattended-run **watchdog**. It scans the resolved `.omc` state root for persistent unattended-mode state files — ralph, autopilot, team, ultragoal — left `active: true` with a stale mtime and surfaces them as advisory context, split into two categories.

- **`[STALE RUN]`**: the signature of a run whose process died mid-flight. The message names the mode, approximate age, and state path, and points at reclaiming the state via `/oh-my-claudecode:cancel` or re-entering the mode.
- **`[AWAITING CONFIRMATION]`**: the run is parked on a confirmation prompt and has emitted no activity since `awaiting_confirmation_set_at`. It is reported separately so a live-but-paused run is not called dead; the message names the mode, session, `since` timestamp, and state path, and points at answering the prompt or cancelling if the run is gone.
- **Threshold**: 2 hours of mtime silence (matching the persistent-mode freshness window); tunable via `OMC_STALE_RUN_HOURS`.
- **Confirmation expiry**: the waiting category requires the marker to be the file's last write — `awaiting_confirmation_set_at` must parse, must not be in the future, and must be within a few seconds of the state file's mtime. `keyword-detector.mjs` writes both in the same atomic write, so a genuinely parked run keeps them aligned no matter how old it is; a leftover flag on a file that was written again afterwards has an mtime later than `set_at` and falls back to `[STALE RUN]`.
- **Coverage**: both layouts — legacy `.omc/state/<mode>-state.json` and session-scoped `.omc/state/sessions/<sessionId>/<mode>-state.json`. The starting session's own state is excluded; malformed state files are ignored, never findings.
- **Doctrine**: the watchdog observes and reports only. It never mutates state, never resumes a run, and never infers approval — reclaiming a dead run (`/oh-my-claudecode:cancel` to clean up, or re-entering the mode to resume from artifacts) is always a human decision.


---

## Context Management Hooks

Claude Code's context window is finite. During long sessions, compaction occurs and previous conversation content is summarized. OMC's context management hooks prepare for compaction, preserve important information, and maintain project-level memory.

### notepad

A compaction-resistant memory system.

- **Storage path**: `.omc/notepad.md`
- **MCP tools**: `notepad_read`, `notepad_write_priority`, `notepad_write_working`, `notepad_write_manual`
- **Behavior**: Information written to the notepad persists after compaction

The notepad supports three priority levels:

| Priority | Tool | Description |
|----------|------|-------------|
| Priority | `notepad_write_priority` | Information that must never be lost |
| Working | `notepad_write_working` | Current work-in-progress status |
| Manual | `notepad_write_manual` | Manually recorded notes |

Use `notepad_prune` to clean up old entries and `notepad_stats` to check status.

### project-memory

Manages permanent project-level memory.

- **Storage path**: `.omc/project-memory.json`
- **MCP tools**: `project_memory_read`, `project_memory_write`, `project_memory_add_note`, `project_memory_add_directive`
- **Related hooks**:
  - `project-memory-session.mjs` (SessionStart): Loads project memory when session starts
  - `project-memory-posttool.mjs` (PostToolUse): Updates memory after tool use
  - `project-memory-precompact.mjs` (PreCompact): Preserves memory before compaction
- **Multi-session contract**: Both writers acquire `withProjectMemoryLock` (see `src/lib/file-lock.ts`) before reading or rewriting `project-memory.json`. Concurrent sessions in the same workspace serialize through this lock, so lost-update races between parallel Claude sessions are impossible. See `tests/integration/concurrent-project-memory.test.ts` for the regression guard.

Two types of data are stored in project-memory:

- **Notes**: Learned facts about the project (architecture patterns, bug history, etc.)
- **Directives**: Instructions to follow when working on the project

### pre-compact

Preserves important state immediately before compaction.

- **Event**: PreCompact
- **Behavior**: Summarizes and preserves the current work state, in-progress TODOs, and critical context
- **Purpose**: Retains essential information so work can resume after compaction

### Context Preservation Strategy

OMC's context management hooks cooperate with the following strategy:

```
Session Start
  → Load project-memory
    → [Work in progress]
    → Write important info to notepad
    → Update project-memory
      → [Compaction fires]
      → pre-compact preserves state
      → project-memory preserved
        → [After compaction]
        → Restored via notepad / project-memory
```

---

## Magic Keywords

Magic keywords automatically activate OMC skills or execution modes when specific words or patterns are detected in the user's natural language prompt. No slash command is needed — include a keyword in your prompt and the feature activates automatically.

### How keyword-detector Works

`keyword-detector.mjs` runs on the UserPromptSubmit event.

1. Receives the user prompt and sanitizes it
2. Removes code blocks, XML tags, URLs, and file paths to prevent false positives
3. Matches keyword patterns against the sanitized text
4. Resolves conflicts, then injects the skill invocation instruction

**Safety measures:**

- **Sanitization**: Keywords inside code blocks, within URLs, or in file paths are ignored
- **Team worker protection**: Disabled when the `OMC_TEAM_WORKER` environment variable is set (prevents infinite spawning)
- **Disable**: Set `DISABLE_OMC=1` or `OMC_SKIP_HOOKS=keyword-detector`

### Execution Mode Keywords

These keywords invoke a skill and create a state file.

| Keyword | Skill | Description |
|---------|-------|-------------|
| `cancelomc`, `stopomc` | cancel | Cancels all active modes |
| `ralph`, `don't stop`, `must complete`, `until done` | ralph | Persistent execution until verification completes |
| `autopilot`, `build me`, `I want a`, `handle it all`, `end to end`, `auto-pilot`, `full auto`, `fullsend`, `e2e this` | autopilot | Fully autonomous execution |
| `ralplan` | ralplan | Consensus-based iterative planning |
| `deep interview`, `ouroboros` | deep-interview | Socratic deep interview |

### AI Slop Cleanup Keywords

Supports two pattern types:

**Explicit patterns** (activate on their own):

- `ai-slop`, `anti-slop`, `deslop`, `de-slop`

**Combination patterns** (activate when an action keyword is combined with a smell keyword):

| Action Keywords | Smell Keywords |
|----------------|----------------|
| `cleanup`, `refactor`, `simplify`, `dedupe`, `prune` | `slop`, `duplicate`, `dead code`, `unused code`, `over-abstraction`, `wrapper layers`, `needless abstractions`, `ai-generated`, `tech debt` |

Example: "cleanup the duplicate code" → activates the ai-slop-cleaner skill.

### Agent Shortcut Keywords

Activate agents with natural language instead of slash commands.

| Keyword | Effect | Behavior |
|---------|--------|----------|
| `tdd`, `test first`, `red green` | TDD mode | Enforces test-first writing |
| `code review`, `review code` | Code review mode | Runs comprehensive code review |
| `security review`, `review security` | Security review mode | Runs security-focused review |

These keywords inject an inline mode message rather than invoking a skill.

### Reasoning Enhancement Keywords

| Keyword | Effect |
|---------|--------|
| `ultrathink`, `think hard`, `think deeply` | Activates extended reasoning mode |
| `deepsearch`, `search the codebase`, `find in codebase` | Activates codebase-focused search mode |
| `deep-analyze`, `deepanalyze` | Activates deep analysis mode |

### Localized Triggers (Korean / Japanese)

`keyword-detector.mjs` also recognizes Korean and Japanese aliases for these keywords (e.g. `랄프` / `ラルフ` → ralph, `코드 리뷰` / `コード レビュー` → code-review, `딥 분석` / `ディープ アナライズ` → analyze). Because Korean and Japanese have no ASCII word boundary, these aliases match by substring, so a localized alias inside a longer noun phrase still routes (e.g. `コードレビュー記事を要約して` → code-review).

See [REFERENCE.md → Magic Keywords → Localized triggers](./REFERENCE.md#magic-keywords) for the full alias table and routing-behavior details (reviewer-suffix guard, informational suppression including `違いを教えて`/`何が違う` difference questions).

### Priority and Conflict Resolution

When multiple keywords are detected simultaneously, they resolve by the following priority:

```
cancel  (highest priority, exclusive)
  → ralph
    → autopilot
      → ralplan
        → deep-interview
          → ai-slop-cleaner
            → tdd
              → code-review
                → security-review
                  → ultrathink
                    → deepsearch
                      → analyze
```

`cancel` is exclusive — it ignores all other matches and only runs the cancel action. All other keywords can be matched together and are processed in priority order.

### Usage Examples

```bash
# In Claude Code:

# Autonomous execution
autopilot: implement user authentication with OAuth

# Parallel execution
/oh-my-claudecode:team 3:executor "write all tests for this module"

# Persistent execution
ralph refactor this authentication module

# TDD
implement password validation with tdd

# Code review
code review the recent changes

# Cancel
stopomc
```

### Note on the `team` Keyword

`team` is not auto-detected. It must be invoked explicitly via the `/oh-my-claudecode:team` slash command to prevent infinite spawning.

```
/oh-my-claudecode:team 3:executor "build a fullstack todo app"
```

---

## Jev Judgment Points

**Jev** is a System One API (TypeSafe) that provides calibrated decision-making for OMC's orchestration points. It replaces keyword lists and heuristics for critical decisions like skill triggering, model-tier routing, loop continuation, and context pruning.

### Zero Egress by Default

Jev is **zero egress** — nothing is sent anywhere without explicit configuration:
- No `TYPESAFE_API_KEY` → Jev is disabled; all points run heuristic twins
- No `OMC_JEV` configuration → no points are opted in; even with a key, zero requests are sent
- Heuristic fallback → if Jev times out, is unavailable, or over budget, every point runs its heuristic twin and workflows never block on Jev

### Configuration

Enable Jev with two environment variables:

```bash
# 1. Authenticate to TypeSafe (required, but not sufficient on its own)
export TYPESAFE_API_KEY="your-api-key"

# 2. Explicitly opt in to judgment points
export OMC_JEV="point1,point2:active,all"
```

#### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TYPESAFE_API_KEY` | (absent) | API key for TypeSafe System One. Required to enable Jev; the key alone does not enable any points. |
| `OMC_JEV` | (absent) | Per-point opt-in: `point`, `point:active`, `all` (every point, shadow), `all:active` (every point, active), or `point:off` (that point off, also under `all` and `all:active`). Comma-separated; unknown point names are ignored. |
| `OMC_JEV_TIMEOUT_MS` | `2000` | Per-call timeout in milliseconds (single round-trip measured at 465–605 ms; default allows margin). In active mode the requests of one hook process add up: each waits up to this value plus the resolver buffer (500 ms; 3500 ms for `model-routing`), and the resolver process needs time to start (0.5-1.2 s on a busy Windows laptop). The timeouts in `hooks/hooks.json` of the hooks that wait for Jev (`pre-tool-enforcer`, `post-tool-verifier`, `persistent-mode`, `code-simplifier`) are sized for the default. If you raise this value, check that the sum over the requests of one hook (`persistent-mode` also waits up to 6 s for the bridge) still fits the hook timeout minus the `run.cjs` cushion (0.5 s POSIX, 1.5 s Windows); otherwise `run.cjs` stops the hook and drops its whole output. `keyword-detector.mjs` is capped at 8 s by `run.cjs` whatever its manifest timeout says, so with three active points (`skill-trigger`, `intent`, `task-size`) at the defaults it can still be stopped. |
| `OMC_JEV_MAX_REQUESTS` | `0` (unlimited) | Maximum Jev requests per process. When reached, heuristic twins run for remaining calls. |
| `OMC_JEV_EXCERPT_CHARS` | `200` | Maximum string length sent in state and shadow log. Recursively bounds all strings in the judgment state; question definitions are static text and are sent whole. Does not apply to the points that have their own default (next row). |
| `OMC_JEV_EXCERPT_CHARS_<POINT>` | (unset) | The same limit for one point: the point name upper-cased with dashes as underscores, for example `OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING` (the variable name itself must be upper case). Order for a point: its own variable, then the point's default, then `OMC_JEV_EXCERPT_CHARS`. Point defaults: `model-routing` `12000`; `task-size` `4000`; `skill-trigger` and `intent` `1000`; `learner-extraction` and `loop-continuation` `2000` (the length to which `persistent-mode.mjs` cuts the last assistant message it sends for `loop-continuation`). An invalid value is ignored. To send less of one of these points, set its own variable, for example `OMC_JEV_EXCERPT_CHARS_TASK_SIZE=200`, the limit of earlier releases; `OMC_JEV_EXCERPT_CHARS` alone does not reach a point that has its own default. |
| `OMC_JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | Override for stub servers or tests. |
| `OMC_JEV_LOG_DIR` | `.omc/state/jev` | Shadow-log directory override (test only). |
| `OMC_JEV_QUIET` | (unset) | Set to `1` to silence the env-activation stderr warning. |
| `OMC_JEV_MAX_EFFORT` | `max` | Cap for the subagent reasoning effort set by the active `model-routing` point: `low`, `medium`, `high`, `xhigh`, or `max`, case-insensitive, surrounding spaces ignored. Other values use the default. A lower cap lowers the mapping: `high` restores the cap of earlier releases. A value that is set but not one of these is reported on stderr (unless `OMC_JEV_QUIET=1`) and the default is used. With `OMC_JEV_MAX_EFFORT_ALWAYS=1` the cap also lowers the explicit effort of every other Task/Agent call. See [Model routing: subagent effort](#model-routing-subagent-effort). |
| `OMC_JEV_MAX_EFFORT_ALWAYS` | (unset) | Set to `1` or `true` to apply `OMC_JEV_MAX_EFFORT` to the explicit `effort` of every Task/Agent call, not only to the effort the active `model-routing` point sets: also when the point is off or in shadow mode, when Jev is not asked about the call or gives no usable answer, and when the hook fails. Script hooks only. See [Model routing: subagent effort](#model-routing-subagent-effort). |
| `OMC_JEV_MODEL_ROUTING_CONTEXT` | (unset) | Set to `1` or `true` to add two fields to the `model-routing` state: the Task/Agent call's `description` and `parent_last_user_message`, the last real user message of the parent session (read from the tail of its transcript; tool results, hook-injected reminders and system notices are skipped). Both are bounded by the point's excerpt limit. Script hooks only; the TypeScript resolver ignores it. See [Model routing: what Jev sees](#model-routing-what-jev-sees). |
| `OMC_JEV_MODEL_ROUTING_ALL_AGENTS` | (unset) | Set to `1` or `true` to ask the `model-routing` point about Task/Agent calls that name no model (a `general-purpose` agent without one, `model: "inherit"`) as well. By default Jev is asked only when the call or the agent definition names `haiku`, `sonnet`, or `opus`. Calls and agent definitions that name any other model (for example `fable`) are left alone. Script hooks only. See [Model routing: what Jev sees](#model-routing-what-jev-sees). |
| `OMC_JEV_MODEL_ROUTING_MARKER` | (unset) | Set to `1` or `true` to let the first line of a Task/Agent prompt pin the model and the effort of that call: `use <model>`, `use <model> <effort>`, or `use <effort>`. The marker replaces Jev's answer for what it names, is removed from the prompt the agent receives, and each use is logged to `overrides.jsonl`. `max` is never accepted from a marker. Script hooks only. See [Model routing: the `use` marker](#model-routing-the-use-marker). |
| `OMC_JEV_MODEL_ROUTING_HINTS` | (unset) | Set to `1` or `true` to add two hints to the `model-routing` questions: two sentences in the effort question (mechanical work gets `low` only when it is short, more than ten items or steps get `medium`, several dozen or more, or a check of every item, get `high`) and a clause at the end of the Haiku description of the model-tier question ("also when there are very many such actions or each one has to be checked"). Off, the questions sent to Jev are unchanged. Script hooks only; the TypeScript resolver ignores it. See [Model routing: what Jev sees](#model-routing-what-jev-sees-and-which-calls-are-asked). |
| `OMC_JEV_TASK_SIZE_NOTICE` | (unset) | Set to `1` or `true` to make the active `task-size` point of the hook script report what it did: suppressed heavy modes with the reason, as the TypeScript bridge does, and heavy modes kept although Jev rated the task small (script only). The classifier check behind the suppression also uses the `taskSizeDetection` word limits. Which modes are suppressed by default limits does not change. Script hooks only. See [Task size: heavy-mode suppression](#task-size-heavy-mode-suppression). |
| `OMC_JEV_TASK_SIZE_PREFIX_WINS` | (unset) | Set to `1` or `true` so that a size prefix of the classifier (`quick:`, `simple:`, `tiny:`, `minor:`, `small:`, `just:`, `only:`) makes the active `task-size` point of the hook script drop heavy modes whatever size Jev answers. Script hooks only. See [Task size: heavy-mode suppression](#task-size-heavy-mode-suppression). |
| `OMC_JEV_TASK_SIZE_SLASH_ANYWHERE` | (unset) | Set to `1` or `true` so that a heavy mode typed as a slash command anywhere in the prompt, also as `/omc:<mode>`, is never dropped by the active `task-size` point of the hook script. By default only a slash command at the start of the prompt keeps its mode. Script hooks only. See [Task size: heavy-mode suppression](#task-size-heavy-mode-suppression). |
| `OMC_JEV_GUARD` | (unset) | Set to `1` or `true` to turn on the delivery guard while the `model-routing` point is active: a message when the `pre-tool-enforcer` timeout is too short, when `hooks/hooks.json` or the `OMC_*`, `ANTHROPIC_*`, `TYPESAFE_*` and Claude Code model-routing variables in the `env` section of the user-level `settings.json` changed after the session started, and once a day a check of interrupted hooks and delivered Jev decisions. Script hooks only. See [Delivery guard](#delivery-guard). |
| `OMC_JEV_GUARD_MIN_TIMEOUT_S` | `60` | Seconds the delivery guard requires of the `pre-tool-enforcer` PreToolUse timeout in `hooks/hooks.json`; a lower timeout gets a message at session start. Not a positive number: the default. |
| `OMC_JEV_PLAN_MODE` | (unset) | Behavior while Claude Code is in plan mode (`permission_mode: "plan"`): `shadow` runs every opted-in point in shadow, `off` disables every point. Unset or any other value changes nothing. See [Plan mode](#plan-mode). |
| `OMC_JEV=off` | — | Master switch: disables every point regardless of key or other config. |

#### Point Activation Syntax

`OMC_JEV` accepts comma-separated entries:

```bash
# Shadow mode (Jev runs but decision is not used, heuristic twin is authoritative)
export OMC_JEV="intent,model-routing,task-size"

# Active mode (Jev decision is used if blocking; non-blocking points fire-and-record)
export OMC_JEV="intent:active,model-routing:active"

# Wildcard: all registered points in shadow
export OMC_JEV="all"

# Wildcard: all registered points in active
export OMC_JEV="all:active"

# Turn one point off while the rest stay on (a later non-off entry for the same point turns it back on;
# the suffix is case-insensitive; `all:off` withdraws the wildcard)
export OMC_JEV="all:active,intent:off"

# Master disable
export OMC_JEV="off"
```

Unknown point names are ignored. Activation unions across sources: code-time `ACTIVATED_POINTS` (empty in every release) plus env `:active` suffix; either source activates a point.

#### Plan mode

`OMC_JEV` applies to every Claude Code permission mode. To keep Jev from deciding while Claude Code is in plan mode, set `OMC_JEV_PLAN_MODE`:

```bash
# Active outside plan mode; in plan mode Jev is still called and logged, but the heuristic decides
export OMC_JEV="all:active"
export OMC_JEV_PLAN_MODE="shadow"

# No Jev requests at all while in plan mode
export OMC_JEV_PLAN_MODE="off"
```

The plugin hook scripts read `permission_mode` from each hook payload and apply `OMC_JEV_PLAN_MODE` only when it is `plan`. It narrows existing `OMC_JEV` opt-ins and never enables a point. The TypeScript resolver behind `bridge.ts` receives no permission mode and ignores this variable.

### Shadow vs. Active Mode

Each judgment point operates in one of three states:

| State | Behavior | When It Occurs |
|-------|----------|----------------|
| **off** | Point does not run; heuristic twin is used | No `TYPESAFE_API_KEY`, `OMC_JEV=off`, a `point:off` entry, or point not opted in |
| **shadow** | Both Jev and heuristic run; Jev answer is logged but NOT acted on; heuristic is authoritative; fire-and-forget for non-blocking points | Point is opted in but not activated; Jev unavailable, times out, or over budget |
| **active** | Jev answer IS acted on; blocking points gate behavior, non-blocking points wait (bounded by `OMC_JEV_TIMEOUT_MS`) | Point is opted in and activated via env `:active` or code-time `ACTIVATED_POINTS` |

Once a point is opted in (e.g., `OMC_JEV="model-routing"`), it automatically degrades to shadow if Jev is unavailable, times out, or exceeds the request budget — no workflow blocks on Jev. In active mode, non-blocking points wait for Jev up to `OMC_JEV_TIMEOUT_MS` (default 2000ms); if Jev fails, the heuristic twin is used and the call returns immediately.

### Shadow Log Location

Every Jev judgment that runs in shadow, active, or degraded mode is
appended to the shared shadow log:

```
.omc/state/jev/shadow.jsonl
```

Each line is a JSON record with:
- `ts`: ISO timestamp
- `point`: judgment-point name
- `state`: the bounded state passed to the judgment
- `mode`: `"shadow"`, `"active"`, or `"degraded"`
- `heuristic`: the heuristic twin's result
- `jev`: Jev's first answer, or `null` when the request degrades. In a Noul answer, `noul` is the probability of "yes" from 0 to 1; the hook scripts and `scripts/jev-eval.mjs` read 0.5 or more as yes.
- `answers`: every Jev answer by question name, or `null` when the request degrades. Points that ask more than one question in one request, such as `model-routing`, are read from this map: the API does not guarantee the order of its answers.
- `confidence`: Jev's confidence when provided
- `durationMs`: elapsed request time
- `usage`: Jev-reported token usage when available

Use shadow logs to collect evidence for promotion decisions (ticket 07) and to debug mismatches.

### Heuristic Fallback on Failure

Jev never blocks the workflow:

- **Timeout**: If a call exceeds `OMC_JEV_TIMEOUT_MS`, the heuristic twin runs immediately.
- **Over budget**: If `OMC_JEV_MAX_REQUESTS` is reached, all remaining calls use heuristic twins.
- **Unavailable**: If the API is unreachable or returns an error, heuristic twin is used and the failure is logged.
- **Blocking points**: Even in active mode, if Jev fails, the heuristic twin's decision is used and the workflow continues.

### Judgment Points Registry

Every registered judgment point with its lifecycle hook, decision type, and blocking behavior:

| Point Name | Event | Hook | Decision | Type | Blocking | Activated* |
|------------|-------|------|----------|------|----------|------------|
| `intent` | UserPromptSubmit | keyword-detector | Is this an Intent-intake request? | Noul (yes/no) | No | — |
| `skill-trigger` | UserPromptSubmit | keyword-detector | Which skill should this prompt trigger? | Choice (cancel/ralph/autopilot/…) | No | — |
| `task-size` | UserPromptSubmit | task-size-detector | Is this small/medium/large? | Choice (small/medium/large) | No | — |
| `model-routing` | PreToolUse | delegation-enforcer | Which is the cheapest model (haiku/sonnet/opus) that does the work well? + How much reasoning effort? | Choice (haiku/sonnet/opus) + Score (effort 0-4) | No | — |
| `slop-warning` | PreToolUse | jev-slop-warning | Does this tool input have advisory language? | Noul (yes/no) | No | — |
| `context-pruning` | PostToolUse | post-tool-verifier | How stale is this context candidate? | Score (fresh/recent/aging/stale) | No | — |
| `loop-continuation` | Stop | persistent-mode | Is task complete? + Progress level? | Noul + Score | **Yes** | — |
| `ralph-verdict` | Stop | ralph | Does completion satisfy PRD criteria? | Noul (yes/no) | **Yes** | — |
| `learner-extraction` | Stop | learner | Does this message have extractable memory? | Noul (yes/no) | No | — |
| `simplifier-trigger` | Stop | code-simplifier | Is this change simplification-worthy? | Noul (yes/no) | No | — |

**Activated**: asterisk (`*`) means the point is in `ACTIVATED_POINTS` (empty in all releases; promoted by ticket 07). Use `OMC_JEV=<point>:active` to activate via environment instead.

**Advisory vs. Blocking**:
- **Advisory points** (Blocking=No): Jev answers are recorded in shadow log but do not affect workflow. Useful for collecting calibration data.
- **Blocking points** (Blocking=Yes): In active mode, Jev's yes/no answer gates behavior (e.g., ralph stops when `ralph-verdict` decides completion is met). Timeout, unavailability, or budget exhaustion reverts to heuristic twin.

### Model routing: subagent effort

The `model-routing` point asks two questions in one request, so choosing the effort adds no Jev call:

| Question | Type | Answer |
|----------|------|--------|
| `model-tier` | Choice | `haiku`, `sonnet`, or `opus`: the cheapest model that will do the work well, meaning correctly and completely |
| `effort` | Score 0-4 | 0 low (mechanical work), 1 medium (a typical change or analysis with clear steps), 2 high (multi-file work that needs its own decisions, a diagnosis, or writing a document), 3 xhigh (in-depth analysis, architecture, a high-stakes review, a hard bug), 4 max (exceptionally hard, rare) |

The `model-tier` question asks for the cheapest model that will do the work well, meaning correctly and completely, and describes each model by the work it suits: Haiku for mechanical work whose result follows directly from the data and is easy to check (look up, read, list, count, copy, run a command and report the result, one obvious fix); Sonnet for typical developer and analyst work with a clear goal (code changes in one or a few files, tests, a diagnosis with clear leads, gathering and summarising several sources, a deployment following given steps); Opus for work where a mistake is costly or hard to notice and that needs deep reasoning (architecture with tradeoffs, a hard bug without clear leads, an independent high-stakes review or fact-check, a document on which money or important decisions depend, hard proofs, deciding between conflicting sources, planning a large change). A more expensive model is needed when a cheaper one would clearly be more likely to get the work wrong or to miss something important. The length of the brief, the number of steps, its formal conditions and the name of the agent type do not by themselves raise the choice; the effort question carries the amount of reasoning. In active mode the `choice` field becomes the model of the call, as described below.

The `effort` question asks about the work the delegated agent must actually do and says that the length of the brief and its formal conditions (language and style rules, permission to use subagents, bans, file locations, report format, words in capitals) do not raise the level. The five criteria map one to one onto `low`, `medium`, `high`, `xhigh`, `max`.

In active mode (`OMC_JEV=model-routing:active`), `pre-tool-enforcer.mjs` rounds the effort score to the nearest level and maps it onto the `effort` field of the Task/Agent call:

| Score | Effort |
|-------|--------|
| 0 to 0.5 | `low` |
| above 0.5 and below 1.5 | `medium` |
| 1.5 to 2.5 | `high` |
| above 2.5 and below 3.5 | `xhigh` |
| 3.5 to 4 | `max` |

The ends of the ranges are the exact ties: a score exactly halfway between two levels (0.5, 1.5, 2.5, 3.5) goes to the even level (`low`, `high`, `high`, `max`), so ties do not push the judgment in one direction. There is no confidence threshold and no other adjustment of the score.

Every result is capped by `OMC_JEV_MAX_EFFORT`.

This needs a Claude Code version whose Agent/Task tool schema has an `effort` field (checked on Claude Code 2.1.316).

- Answers are read by question name. An effort answer counts only when its `type` is `score` and its `score` is a number from 0 to 4. A missing or malformed answer leaves its field as it was: a response without `effort` changes only the model, and one without `model-tier` changes only the effort.
- As with the model, Jev's effort replaces an explicit `effort` in the call.
- `OMC_JEV_MAX_EFFORT` defaults to `max`, so the mapping is not capped. `xhigh` and `max` can spend several times the tokens of `high` on a delegated call, but the calibrated question gives them for a minority of briefs. Set the cap to `high` or lower to hold every delegated call at that level: a lower cap such as `medium` lowers every level above it.
- When the point is active and Jev returns no usable effort score, an explicit `effort` above the cap is lowered to the cap; with the default cap (`max`) nothing is lowered, and with `OMC_JEV_MAX_EFFORT=high`, for example, `max` becomes `high`.
- Shadow mode, a degraded call (timeout, HTTP error, invalid response), and plan mode with `OMC_JEV_PLAN_MODE` leave the call exactly as it was, explicit effort included, unless `OMC_JEV_MAX_EFFORT_ALWAYS=1` is set (next item).
- `OMC_JEV_MAX_EFFORT_ALWAYS=1` makes the cap a limit for every Task/Agent call. An explicit `effort` above `OMC_JEV_MAX_EFFORT` is lowered to the cap whether or not Jev sets the effort: in shadow mode and plan mode, with the point off, with `OMC_JEV=off` or without `TYPESAFE_API_KEY`, for a call Jev is not asked about (a model other than haiku, sonnet or opus, or no model without `OMC_JEV_MODEL_ROUTING_ALL_AGENTS`), after a degraded call, and when the hook itself fails with an error (the error path then changes only `effort`). An effort within the cap, an effort that is not one of the five levels, and a call without `effort` are left alone; no effort is added. With the default cap (`max`) it changes nothing. The cap needs the hook to run to the end or to its error path: with `DISABLE_OMC=1` or `OMC_SKIP_HOOKS=pre-tool-use`, and when Claude Code stops the hook at its timeout, the call keeps its effort. Without the variable the cap applies only as described above.

Example: `OMC_JEV=model-routing:active` with `OMC_JEV_MAX_EFFORT=medium`. A call `{ "subagent_type": "executor", "model": "haiku", "effort": "max", ... }` and the answers `{ "effort": { "type": "score", "score": 2.3, ... }, "model-tier": { "type": "choice", "choice": "opus", ... } }` run with `"model": "opus", "effort": "medium"`. With the default cap and the effort score 2.9 the same call runs with `"effort": "xhigh"`, and with the score 3.7 with `"effort": "max"`.

Example: `OMC_JEV_MAX_EFFORT=high` with `OMC_JEV_MAX_EFFORT_ALWAYS=1`. A call `{ "subagent_type": "executor", "model": "fable", "effort": "max", ... }`, which Jev is not asked about, runs with `"effort": "high"`, with or without `OMC_JEV`. Without `OMC_JEV_MAX_EFFORT_ALWAYS` it runs with `"effort": "max"`.

### Model routing: what Jev sees and which calls are asked

By default the `model-routing` state is `tool_name`, `subagent_type` and up to 12000 characters of the task. The effort question judges the work the delegated agent must do, and a task cut to 200 characters hides most of it, so this point has its own default limit and ignores the global `OMC_JEV_EXCERPT_CHARS` (which still bounds every point without its own default). To change it, set `OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING`; a smaller value sends less of the task and, in the measurement behind the calibrated question, makes its answers too low. The request carries more text than before, and the round trip stayed about the same in a small test (three requests each: 1.5 s at 300 characters, 1.6 s at 12000). Three variables control what is sent and which calls are asked:

- `OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING=<n>` sets the limit for the task and for the extra fields below. The fields that decide the routing (`subagent_type`, `model`, `effort`, `resume`) always keep a fixed 500 characters in the hook.
- `OMC_JEV_MODEL_ROUTING_CONTEXT=1` adds `description` and `parent_last_user_message` to the state. The message is the user's own last real message in the parent session, a new kind of data next to the task, and it leaves your machine like the task does, so enable it only where that is acceptable. Both fields are also written to the local shadow log (`state`), and the message, before it is cut, to the short-lived request file in the temporary directory. The hook reads it from the tail of the session's own transcript (`<session_id>.jsonl`, a regular file, not a symlink), skips tool results, hook-injected reminders, compact summaries, sidechain entries, task, teammate and command notices, interruption markers, and the notices of the Claude desktop app (side-session and CI-monitor events, scheduled tasks, messages from another Claude session), cuts it to 4000 characters and then to the point limit. When no matching transcript is found, only the description is added.
- `OMC_JEV_MODEL_ROUTING_ALL_AGENTS=1` asks about calls that name no model too: calls to `general-purpose` without a model and calls to an agent whose definition (plugin, project or user) has no `model:` field or says `inherit`. Without it those calls never reach Jev, so Jev can set neither their model nor their effort. A call that names any other model than haiku, sonnet or opus (`fable`, a non-Claude proxy model), or an agent definition that does, is left alone; a provider-specific Claude ID such as `us.anthropic.claude-sonnet-...` counts as its tier and is routed with or without the variable. In shadow mode the comparison is logged with a null heuristic (there is no twin tier to compare); in active mode Jev's answers set the model and the effort as usual. With `forceInherit` a call without a model keeps inheriting the session model unless the provider resolves the tier alias Jev picks (`ANTHROPIC_DEFAULT_<TIER>_MODEL` and the other variables the hook already checks); its effort is still set.
- `OMC_JEV_MODEL_ROUTING_HINTS=1` changes the questions, not the state. The effort question gets two more sentences: "Mechanical work gets the low level only when it is short: one action or a few. Mechanical work with more than ten items or steps gets the medium level, and with several dozen or more, or when every item has to be checked, the high level." The Haiku description of the model-tier question gets the clause "; also when there are very many such actions or each one has to be checked". The other descriptions and the five effort levels are not touched. Without the variable the questions are exactly as before. The texts were measured only in their Polish original, and the English wording is a translation that has not been measured (74 logged tasks, 98 labelled tasks): together they moved 6 of 74 tasks from `medium` to `high` and 6 of 74 from Sonnet to Haiku, with an estimated cost 2.6% lower, and agreement with hand labels was not better (model 89 of 98 with the hints against 91 of 98 without, effort 65 of 84 against 66 of 84). Treat these numbers as a hint for the English wording, not as proof, and check the effect on your own calls in the shadow log before relying on it. The hook builds the questions once per process, so the variable is read at start. A `use` marker (`OMC_JEV_MODEL_ROUTING_MARKER`) removes the question it settles as before, and the cap `OMC_JEV_MAX_EFFORT` and `OMC_JEV_MAX_EFFORT_ALWAYS` apply to the resulting effort as before.

All four are off by default, and nothing changes without them.

### Model routing: the `use` marker

In active mode Jev replaces the model and the effort of a delegated call, an explicit `model` or `effort` included, so the session that writes the call has no way to say "this one runs on this model". `OMC_JEV_MODEL_ROUTING_MARKER=1` adds one: a marker in the first line of the prompt of a Task/Agent call.

| First line of the prompt | Effect |
|--------------------------|--------|
| `use <model>` | pins the model; Jev is asked only the `effort` question (when it would be asked about the call at all, see below) |
| `use <model> <effort>` | pins both; Jev is not asked |
| `use <effort>` | pins the effort; Jev is asked only the `model-tier` question (when it would be asked about the call at all, see below) |

- `<model>` is `haiku`, `sonnet`, `opus`, or `fable`; `<effort>` is `low`, `medium`, `high`, or `xhigh`. The two sets do not overlap, so `use high` is an effort. `fable` can be chosen only this way: Jev answers haiku, sonnet, or opus.
- The whole first non-empty line must have this form; case and surrounding spaces do not matter. A marker on a later line, in `description`, or in a line with other text is plain text and changes nothing.
- The marker wins over the call's own `model` and `effort` and over Jev's answers. Jev, when it is asked, sees the task without the marker line.
- Whether Jev is asked about the call at all follows the usual rules for the call's model, with the marker's model counted as the call's: a call that names no model is asked about only with `OMC_JEV_MODEL_ROUTING_ALL_AGENTS=1`, so `use opus` on such a call pins the model and leaves the effort question to Jev, while `use high` alone on it sends nothing to Jev.
- The line, the empty lines before it, and one empty line after it are removed from the prompt in `updatedInput`, because the line is an instruction for the hook, not for the agent. A prompt that is only the marker keeps it.
- `max` stays Jev's decision (and the cap's). `use max` and `use <model> max` do not set an effort: `use <model> max` still pins the model, `use max` alone changes nothing and leaves the line in the prompt. The refusal is logged in `rejected`.
- The effort from a marker is capped by `OMC_JEV_MAX_EFFORT` like Jev's; the log row then has `"capped": true` and the requested level.
- With `forceInherit` a marker model is set only when the provider resolves its tier alias (`OMC_SUBAGENT_MODEL`, `CLAUDE_CODE_BEDROCK_<TIER>_MODEL`, `ANTHROPIC_DEFAULT_<TIER>_MODEL`; `fable` included), as for any tier alias the hook checks under `forceInherit`. A marker with an effort still sets the effort and the log row has `"rejected": ["force-inherit"]`; a marker that names only such a model changes nothing and stays in the prompt, like `use max`. The `forceInherit` denials of the call's own model run before the marker is read.
- The marker is an explicit instruction, so it applies in shadow mode too and when the `model-routing` point is off or there is no `TYPESAFE_API_KEY`. In shadow mode the Jev request still goes out for the questions the marker leaves open and its answers change nothing.
- Every use is logged as one line in `overrides.jsonl` in the Jev log directory, next to `shadow.jsonl` but separate from it, because `jev-eval` counts every line of `shadow.jsonl` as a Jev request. A row carries `ts`, `point`, `session_id`, `subagent_type`, the literal `marker` line, `override` (`model`, `effort`, or `both`), the `model` and `effort` `from` and `to`, and `rejected` when something was refused. The row is written when the hook decides, so a call that a later check denies still has its row.

Example: `OMC_JEV=model-routing:active`, a call with `"model": "haiku"` and the prompt `use sonnet low` then the task. The hook sends no request to Jev, and the call runs with `"model": "sonnet", "effort": "low"` and the task alone as its prompt. The same call with the prompt `use sonnet` runs on sonnet with the effort Jev chooses for the task.

Without the variable the hook behaves exactly as before: the line stays in the prompt and Jev decides.

### Context pruning: staleness score

`post-tool-verifier.mjs` asks the `context-pruning` point only for large-output tools (read, grep, glob, bash, webfetch, and the task tools) and only once context usage reaches the warning threshold (default 70%). The `staleness` question is a Score 0-3, and a score answer carries no `choice`, so in active mode the score is rounded to the nearest label and mapped to an action:

| Score | Label | Action |
|-------|-------|--------|
| < 0.5 | `fresh` | no message |
| 0.5 to < 1.5 | `recent` | no message |
| 1.5 to < 2.5 | `aging` | `[OMC WARNING]` |
| 2.5 to 3 | `stale` | `[OMC CRITICAL]` |

- Jev changes the level only below the critical threshold (default 90%). At or above it the hook always emits `[OMC CRITICAL]` and asks for `/compact`, whatever Jev answers, subject to the usual warning cooldown.
- A score outside 0-3, a non-numeric score, or an answer of another type is ignored and the heuristic action stays, even when that answer carries a `choice`. In a score answer, a string `choice` that names one of the four labels, matched case-insensitively, takes precedence over the score.

### Task size: heavy-mode suppression

In active mode (`OMC_JEV=task-size:active`), `keyword-detector.mjs` drops the heavy modes `ralph`, `autopilot` and `ralplan` detected in a prompt (`team` is on the list too, but the script no longer detects it in the text, so it is never dropped) when all of these hold: `taskSizeDetection.enabled` and `taskSizeDetection.suppressHeavyModesForSmallTasks` are not `false`, Jev answers `small` with a confidence of at least 0.9, and the classifier (`classifyTaskSize`) also rates the prompt small or the prompt starts with a size prefix (`quick:`, `small:`, `tiny:`, `minimal:`, `fast:`, `speed:`, `urgent:`). A mode typed as a slash command at the start of the prompt (`/ralph`, `/oh-my-claudecode:ralph`) is never dropped. By default the hook drops the modes silently, and the classifier check uses the default word limits (50 and 200).

`OMC_JEV_TASK_SIZE_NOTICE=1` (or `true`) changes two things:

- The outcome is added to `additionalContext`. Dropped modes, as the TypeScript bridge (`src/hooks/bridge.ts`) reports them: `[TASK-SIZE: SMALL] Heavy orchestration mode(s) suppressed: ralph.` with the reason (Jev's confidence and the classifier's reason, or the size prefix) and how to run the mode anyway. Heavy modes kept although Jev rated the task small, which the bridge never does because it drops heavy modes on any `small` answer: `[TASK-SIZE] Heavy mode(s) kept although Jev rated this task small: ralph (Jev confidence 0.5 is below 0.9).`, with the reason for each mode (confidence below 0.9 or none given, the classifier does not rate the task small and there is no size prefix, or a slash command).
- The classifier check uses `taskSizeDetection.smallWordLimit` and `taskSizeDetection.largeWordLimit` from the user and project config, which the bridge also reads. Without them in the config the limits stay 50 and 200. The `heuristic` written to the shadow log keeps the default limits, as the bridge's twin does.

With the default limits, which modes are dropped does not change. Shadow mode, a degraded call, Jev answers other than `small` and the two config opt-outs add nothing. An approved follow-up shortcut after `ralplan` (a short `team` or `ralph` prompt that launches the approved plan) is handled after this step and prints its own output, so a task-size note is not shown for it.

`OMC_JEV_TASK_SIZE_PREFIX_WINS=1` (or `true`): a size prefix of the classifier (`quick:`, `simple:`, `tiny:`, `minor:`, `small:`, `just:`, `only:`), which `classifyTaskSize` always rates small, drops the heavy modes whatever size Jev answers and whatever its confidence. The point must still be active and Jev must still answer: a degraded call drops nothing. The other prefixes above (`minimal:`, `fast:`, `speed:`, `urgent:`) keep needing a `small` answer with a confidence of at least 0.9. A slash command at the start of the prompt still keeps its mode. With `OMC_JEV_TASK_SIZE_NOTICE=1` the notice names the prefix as the reason when it won over another answer.

`OMC_JEV_TASK_SIZE_SLASH_ANYWHERE=1` (or `true`): a heavy mode typed as a slash command anywhere in the prompt is never dropped, also through the `/omc:` alias: `/ralph`, `/oh-my-claudecode:ralph` and `/omc:ralph` at the start, after whitespace, or after an opening parenthesis or quote, and followed by whitespace, the end of the prompt, a closing parenthesis, a closing square bracket or a quote, `?`, `!`, `,`, `;`, `:`, or a `.` that is not followed by a letter, digit or underscore. A mode name inside a path (`a/ralph`) or a file name (`/ralph.md`) is not a slash command. The check reads the prompt after code blocks, inline code, quoted lines and pasted payloads are removed, as keyword detection does, so a `/ralph` quoted there does not count. The slash command also keeps its mode when a size prefix wins under `OMC_JEV_TASK_SIZE_PREFIX_WINS`. With `OMC_JEV_TASK_SIZE_NOTICE=1` the notice says that a slash command anywhere in the prompt keeps its mode. When an active task-size decision applies, such a slash command also counts as the user's confirmation, so ralph arms no awaiting-confirmation window; in shadow mode or with Jev off a mid-prompt slash command keeps that window. In every other case only `/ralph` or `/oh-my-claudecode:ralph` at the start of the prompt as typed, before inline code is removed, confirms ralph.

Shadow mode, the TypeScript bridge and the other task-size rules do not change.

### Delivery guard

In active mode the model and effort Jev picks for a Task/Agent call travel in the output of the `pre-tool-enforcer` PreToolUse hook. When Claude Code cuts that hook off at its `hooks.json` timeout, it drops the output: the Jev log still shows the correct answer, and only the hand-over is lost. Claude Code also reads `hooks/hooks.json` and the `env` section of `settings.json` once, at session start, so a session that started before such a change keeps the old values. `OMC_JEV_GUARD=1` (or `true`) turns on three checks. They run only while `model-routing` is active, use no network, never ask Jev, and never break a hook (a failure of the guard changes nothing).

| Check | When | Message when |
|-------|------|--------------|
| Timeout | session start | the smallest numeric timeout of the `pre-tool-enforcer` PreToolUse entries in the plugin's `hooks/hooks.json` is below `OMC_JEV_GUARD_MIN_TIMEOUT_S` (default 60). An entry without a `timeout` field, or a plugin file without such an entry (hooks installed through `settings.json`), gives no message. |
| Changed since start | each prompt | `hooks/hooks.json` or the `OMC_*`, `ANTHROPIC_*` and `TYPESAFE_*` keys and the Claude Code model-routing keys (`CLAUDE_CODE_BEDROCK_*`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_MODEL`) of the `env` section of the user-level `settings.json` (`<Claude config dir>/settings.json`; project and local settings are not read) differ from what the session saw at start. One message per change and session: restart the session. Hook scripts load on every call, so a change to scripts alone needs no restart and gives no message. |
| Daily check | prompt, at most once per 24 hours and Jev log directory | a detached process finds an interrupted `PreToolUse:Agent` hook in the last 24 hours, or fewer than 95 % of the active `model-routing` decisions reached an agent with the model Jev chose; the next prompt of each session shows the result once, for up to two days. If the check itself fails, the message says so and the check runs again after 24 hours. |

How the daily check reads data:

- Interrupted hooks: the session transcripts under `<Claude config dir>/projects` are scanned for hook attachments with `"timedOut":true`. Only the hook name, command, time and tool use id of such lines are read; nothing from a transcript is stored or printed. Every plugin's hook on the event has the hook name `PreToolUse:Agent`; a record counts as another command's when its `command` is neither `pre-tool-enforcer` nor the label Claude Code shows for a hook defined with `args` (`command hook N`), so such labelled hooks of other plugins are counted too.
- Delivered decisions: `shadow.jsonl` lines of the Jev log directory of the project of the prompt (`OMC_JEV_LOG_DIR`, else `.omc/state/jev`), and rotated `shadow-<stamp>-<pid>.jsonl` files next to it if there are any, that carry a `tool_use_id` field are joined to the `agent-*.meta.json` files of the agents on `toolUseId` and compared on the model: the alias, a full id that contains the alias as a whole word (`claude-opus-4-8` for `opus`), or the id the configuration maps the tier to (the first set of `CLAUDE_CODE_BEDROCK_<TIER>_MODEL`, `ANTHROPIC_DEFAULT_<TIER>_MODEL`, the variables Claude Code reads for a tier alias; such as `kimi-k2.6:cloud` for a proxy). Never a prefix: a `claude-opus-...` agent is not a `haiku` delivery. The detached check inherits the environment of the session; a run by hand reads the environment of its own shell, so set the same variables there to get the same figures. Decisions younger than two minutes and decisions with no agent found are left out. A call the hook deliberately left alone (a `use` marker, `forceInherit` in the configuration) counts as not delivered; with `OMC_ROUTING_FORCE_INHERIT=true` the share is not computed. Lines without a `tool_use_id` are skipped, so with a log that does not record tool use ids the share stays empty and the check reports interruptions only.
- Each project has its own Jev log directory, so each gets its own daily slot and result.

State is kept under `<Claude config dir>/.omc/jev-guard/`: a record per session id with the start time and the two hashes (sha256, 16 hex digits; the values behind them, which can be API keys, are never stored), plus the files of the daily check (`daily-<key>.json`, `daily-<key>.lock`, `delivery-<key>.json`). A session that starts without a record, or after `/clear`, takes its baseline at that moment, so a change made before then is not reported. Records not used for 14 days are swept once a day; every prompt and every `/compact` marks the session's record as in use (its modification time only, the content is not rewritten), so a live session keeps its baseline. The daily process runs at the lowest priority. Run it by hand with `node scripts/lib/jev-delivery-guard.mjs --daily --print [--config <Claude config dir>] [--log <Jev log dir>] [--window-hours <n>]`: it prints the figures and leaves the state alone unless `--write` is given.

Without the variable no file is read or written and the hooks behave exactly as before.

### Request Budget and Latency

Set limits to control cost and latency:

```bash
# Limit to 100 requests per process
export OMC_JEV_MAX_REQUESTS=100

# Raise timeout for slow networks
export OMC_JEV_TIMEOUT_MS=5000

# Truncate large state excerpts (points that have their own default, see the
# variable table, need their own variable, e.g. OMC_JEV_EXCERPT_CHARS_TASK_SIZE=500)
export OMC_JEV_EXCERPT_CHARS=500
```

Once the request budget is exhausted, all remaining points run heuristic twins.

### Example Configurations

#### Shadow Mode (Collect Data)

Run every point in shadow to collect calibration evidence:

```bash
export TYPESAFE_API_KEY="sk-..."
export OMC_JEV="all"  # All points in shadow; heuristic is authoritative
```

Review shadow logs at `.omc/state/jev/` to see how well Jev matches your heuristics.

#### Active Model Routing Only

Activate Jev only for model-tier decisions:

```bash
export TYPESAFE_API_KEY="sk-..."
export OMC_JEV="model-routing:active"  # Only this point, active
```

#### Production (All Points Active)

When evidence shows Jev outperforms heuristics on all points:

```bash
export TYPESAFE_API_KEY="sk-..."
export OMC_JEV="all:active"  # All points, active; Jev decides
export OMC_JEV_MAX_REQUESTS=1000  # Cost control
```

#### Disable Jev Globally

```bash
export OMC_JEV="off"  # Master switch
```

Or simply omit `TYPESAFE_API_KEY`.

### Debugging

#### Check What Was Decided

Read the shadow log for a point:

```bash
jq 'select(.point == "model-routing")' .omc/state/jev/shadow.jsonl
```

#### Verify Jev is Running

Look for stderr output on point activation:

```
[jev] model-routing: ACTIVE via env — Jev decides
```

If this does not appear, the point is not activated or Jev is disabled.

#### Quiet the Warning

```bash
export OMC_JEV_QUIET=1  # Suppress the activation message
```

### References

- **Decision Model**: [Jev Issue #3669](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3669) — user stories and design
- **Degradation Contract**: [ADR 03665](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/dev/docs/adr/03665-jev-degradation-contract.md) — how Jev fails gracefully
- **Env Activation**: [ADR 03672](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/dev/docs/adr/03672-env-activated-active-mode.md) — `:active` syntax and union semantics
- **Script-Side Points**: [ADR 03671](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/dev/docs/adr/03671-script-side-judgment-channel.md) — hook-script integration points
