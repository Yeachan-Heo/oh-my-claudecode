# oh-my-claudecode v4.13.3: Bug Fixes

## Release Notes

Release with **4 bug fixes**, **11 other changes** across **15 merged PRs**.

### Highlights

- **fix(shell): portable shebangs + POSIX /bin/sh fallback** (#2783)
- **fix: align .omc/skills persistence contract across ignore rules, setup, and docs** (#2787)
- **fix(cleanup-orphans): unref SIGKILL escalation timer to avoid 5s CLI hang** (#2774)

### Bug Fixes

- **fix(shell): portable shebangs + POSIX /bin/sh fallback** (#2783)
- **fix: align .omc/skills persistence contract across ignore rules, setup, and docs** (#2787)
- **fix(cleanup-orphans): unref SIGKILL escalation timer to avoid 5s CLI hang** (#2774)
- **fix(installer): validate MCP server names before rendering Codex TOML** (#2764)

### Other Changes

- **Guard write/edit success envelopes in post-tool verifier** (#2793)
- **Fix outdated Codex/Gemini team worker launch contracts** (#2791)
- **Clarify bundled agent effort inheritance** (#2788)
- **Preserve provider routing guidance across SessionStart hooks** (#2780)
- **Centralize ultrawork protocol routing** (#2761)
- **Reduce prompt token melting at hook ingress** (#2778)
- **Make learned custom skills visible to Claude Code** (#2775)
- **Fix broken published docs links** (#2766)
- **Prevent project-memory hook noise from object tool results** (#2760)
- **Fix /ccg routing when PATH omc is stale** (#2758)
- **Keep deep-interview summary gating on AskUserQuestion path** (#2756)

### Stats

- **15 PRs merged** | **0 new features** | **4 bug fixes** | **0 security/hardening improvements** | **11 other changes**
