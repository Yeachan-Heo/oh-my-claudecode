## Install / Upgrade

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask`, `ccg`, and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm i -g oh-my-claude-sisyphus@{{VERSION}}
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

> **Package naming note:** the repo, plugin, and commands are branded **oh-my-claudecode**, but the published npm package name remains [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus).
