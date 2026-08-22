# oh-my-claudecode v5.0.0: Workflow Retirement

## Release Notes

Major release that trims the public workflow surface to four canonical workflows and **removes 17 legacy names outright** rather than keeping them as compatibility aliases.

See the [Migration Guide](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/main/docs/MIGRATION.md#v4x--v50-workflow-retirement) for the full replacement table and migration steps.

### ⚠️ Breaking Changes

- **Retired 14 skills and 7 commands.** `ultrawork`, `ultraqa`, `ultrapilot`, `swarm`, `pipeline`, `merge-readiness`, `deep-dive`, `sciomc`, `ccg`, `omc-teams`, `setup`, `mcp-setup`, `omc-reference`, `learner`, `writer-memory`, `local-build-reminder`, and the `understanding-gate` alias no longer resolve.
- **`review` installs as `omc-review`**, matching how `plan` installs as `omc-plan` — both collide with Claude Code native commands.

| Removed | Replacement |
| --- | --- |
| `ultrawork`, `ultrapilot`, `swarm`, `pipeline` | `/execute`, or `/team` for coordinated parallel workers |
| `ultraqa` | `/verify` |
| `merge-readiness`, `understanding-gate` | `/review` |
| `deep-dive`, `sciomc` | `/research` |
| `ccg` | `/ask codex` + `/ask antigravity`, then synthesize |
| `omc-teams` | `/team` or `omc team` |
| `setup`, `mcp-setup` | `/omc-setup` |
| `omc-reference` | `/wiki` |
| `learner`, `writer-memory` | `/remember` |
| `local-build-reminder` | — (docs and CI cover the signal) |

### Highlights

- **Canonical Tier-0 surface**: `plan` → `execute` → `review` → `verify`, with roles `planner` → `executor` → `reviewer` → `verifier`
- **`execute`, `review`, and `research` now exist.** They were registry declarations with no skill files, while the resolver routed seven legacy names at them — every one a dead route
- **`verify`, `remember`, and `debug` are available to all users**, no longer gated behind an internal entitlement
- **Kept by design**: `autopilot`, `autoresearch`, `ultragoal`, `ralph`, `deep-interview`, `ralplan`, and `team` remain directly invocable

### New Features

- **feat(workflow): author the execute, review, and research skills**
- **feat(skills): ungate remember, verify, and debug**
- **feat(alias-retirement): authorize breaking removal at a major boundary** — a major bump now satisfies the retirement gates on its own, except for the critical-integrations check, which still blocks

### Bug Fixes

- **fix(installer): prune the pre-rename directory when a skill is renamed** — `cleanupStaleSkills` kept both the raw and `omc-`prefixed names in its keep-set, leaving `plan/` and `omc-plan/` installed side by side
- **fix(workflow): reconcile the registry and resolver** — the resolver aliased `team`, `ai-slop-cleaner`, `visual-verdict`, and `self-improve` away despite the registry marking them `keep`, and routed `sciomc`/`deep-dive`/`autoresearch` to `plan` where the registry said `research`
- **fix(plugin): sync `plugin.json` to disk** — it enumerated every retired skill and pointed at directories that no longer exist

### Stats

- **17 names retired** | **3 new skills** | **3 skills ungated** | **3 bug fixes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.0.0
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

After updating, run `omc setup` (or `/omc-setup`). The installer prunes the retired skill directories automatically — no manual cleanup needed.

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.15.10...v5.0.0
