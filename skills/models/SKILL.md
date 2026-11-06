---
name: models
description: "Interactive setup for role-based model routing: edit team.roleRouting (provider, tier, per-provider reasoning effort; orchestrator model-only), check panel diversity, warn on missing provider CLIs."
aliases: []
metadata:
  credits:
    role-model-sheet: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Models

Setup wizard for role-based model routing. OMC resolves each agent role to a
provider, model, and reasoning effort through `team.roleRouting` in the
project config (`.claude/omc.jsonc`) or the user config at
`claude-omc/config.jsonc` under OMC's platform config dir — `$XDG_CONFIG_HOME`
(default `~/.config`) on POSIX, `%APPDATA%` on Windows, the same resolver
`getConfigPaths()` uses — never a hard-coded `~/.config` path. Run
`omc config` to see the effective values before editing. This skill reads
the current routing, walks the user through changes, writes the block, and
checks panel diversity. It never edits config silently.

## What is configurable

Per role (canonical names: `orchestrator`, `planner`, `analyst`, `architect`,
`executor`, `debugger`, `critic`, `code-reviewer`, `security-reviewer`,
`test-engineer`, `designer`, `writer`, `code-simplifier`, `explore`,
`document-specialist`):

```jsonc
{
  "team": {
    "roleRouting": {
      "executor": { "provider": "claude", "model": "MEDIUM", "reasoningEffort": "high" },
      "code-reviewer": { "provider": "codex" }
    }
  }
}
```

- `provider`: `claude` | `codex` | `gemini` | `grok` | `cursor` | `antigravity`
  — except `orchestrator`, which is pinned to Claude
- `model`: tier `HIGH` | `MEDIUM` | `LOW`, or an explicit model ID
  — the **only** key `orchestrator` accepts; provider and reasoningEffort
  are rejected for it (config validation fails closed at team start), so
  the wizard offers model-only for that role
- `reasoningEffort`: per-provider only — Claude `low|medium|high|xhigh|max`,
  Codex `low|medium|high|xhigh|max|ultra`, Antigravity
  `low|medium|high|max`; Gemini, Grok, and Cursor accept no effort field.
  Offer only the seated provider's set — an off-list value is rejected at
  config load by `validateTeamConfig`, before any team starts
- unset roles keep their defaults; routing is resolved once at team start and
  frozen for that run

## Workflow

1. Show current resolution: read the active config file(s) and print each
   configured role with provider/model/effort, marking defaults.
2. Ask what to change — one role at a time, offering the tiers and, when the
   user has provider CLIs installed, cross-provider options. Confirm each
   choice before writing.
3. Write the block with a single atomic edit to the project config unless the
   user asks for user scope. Preserve every other key and all comments where
   the format allows.
4. Re-read the file and print the resulting resolution for confirmation.
5. Warn on provider CLIs that are not installed (`codex`, `gemini`, `grok`,
   `cursor-agent`, `agy`) — routing to a missing CLI fails closed at team start.

## Panel diversity check

Multi-model panel runs work best when the panel spans model families.
Before such a run, check the seated panel: if every seat is
the same provider and the same model family, recommend diversifying one seat
to a different family. Two seats on one family plus one on another is
acceptable; three identical seats defeats the mechanism and should be called
out before the run starts.

## Notes

- This skill only writes configuration. It never starts a team, spawns
  agents, or changes model routing for an already-running team.
- `delegationRouting` is partially deprecated: entries routing to the
  external Codex/Gemini providers should migrate into `team.roleRouting`;
  valid Claude Task routes (including `agentType` and fallback settings)
  are a separate subsystem and must stay where they are — `team.roleRouting`
  governs `/team` only, Task delegation is not moved by this skill.
