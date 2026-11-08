## OMC v5.0.2

v5.0.2 improves Claude Code workflow guidance and hardens graph artifact containment. On macOS and Windows, graph execution remains intentionally fail-closed when a safe directory-descriptor primitive is unavailable.

## Install / Upgrade

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask`, `ccg`, and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm i -g oh-my-claude-sisyphus@5.0.2
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

> **Package naming note:** the repo, plugin, and commands are branded **oh-my-claudecode**, but the published npm package name remains [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus).
