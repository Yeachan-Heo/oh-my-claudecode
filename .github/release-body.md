# oh-my-claudecode v5.8.0: Jev effort routing, pstack skill suites, team bridge removal

## Release Notes

v5.8.0 is the first release of the 5.8 series. It removes the unused `oh-my-claude-sisyphus/team` MCP bridge, which is a breaking change. It also adds calibrated Jev effort routing and brings in the pstack skill suites, along with a set of ralph, hook, session-end and Windows fixes. **Note:** v5.7.31 was tagged but never published, so this release follows v5.7.30.

### ⚠️ Breaking Changes

- **Removed the team MCP bridge** (#4788). The `oh-my-claude-sisyphus/team` package export and its MCP server bridge are gone, because nothing spawned them. Use the `team` skill or the `omc team` command surface instead.

### Features

- **feat(jev): calibrated five-level effort for model-routing** (#4850), building on **model-routing choosing subagent effort** (#4810) and **an effort range in model-routing** (#4820)
- **feat(skills): pstack suites**: PR-care (#4579), panel/generator/utility (#4589), principles and benchmark-checklist (#4592), review-and-climb, statechart (TLA+ model checking) and ketchup-video (#4840), plus pstack wording-drift syncs (#4841, #4849)
- **feat(core): pstack-inspired mechanisms**: watch-pr policy, verification ledger, playbook checker and credits registry (#4578)

### Bug Fixes

- **fix(session-end): derive the foreground budget and recover orphaned claims** (#4845)
- **fix(cli): keep unmanaged keys when config commands rewrite `.omc-config.json`** (#4843)
- **fix(verification): run the epic closure verifier on Windows** (#4848)
- **fix(hud): hide the console window for the Windows npm-root fallback** (#4847)
- **fix(ralph): more accurate feedback signatures for pytest and vitest output** (#4800, #4801, #4802, #4819)
- **fix(jev): fixes to the context-pruning answer gate, staleness mapping and active-mode answers** (#4807, #4808, #4809, #4818)
- **fix(hooks): stop flagging a run that is awaiting confirmation as crashed** (#4799), and keep the plugin and standalone helper copies identical (#4784)
- **fix: `isCmuxSurfaceTarget` no longer misclassifies herdr pane ids** (#4817)

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.8.0
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.30...v5.8.0

## Contributors

Thank you to all contributors who made this release possible!

@Yeachan-Heo @pangpang778 @Jack11111eee @maciejdrazkowski @iyoda @tanishqbaweja @LukeTheoJohnson @topazyo
