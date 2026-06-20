# oh-my-claudecode v4.14.8: Windows transcript fixes, team worker polish, and release hardening

## Release Notes

Release with **1 new feature**, **8 bug fixes**, **2 documentation updates**, and **8 maintenance / CI improvements** across the post-`v4.14.7` dev line.

### Highlights

- **Windows transcript/path reliability:** fixes current-scope session search and worktree transcript resolution on Windows by converging Claude project-dir encoding and separator handling.
- **HUD API-key guidance:** API-key users now see a clear hint when built-in usage data is unavailable and no custom rate-limits provider is configured.
- **Persistent-mode stability:** bounds thinking-only continuation loops to avoid runaway continuation behavior.
- **Windows / psmux team mode polish:** native Windows psmux team worker launch and docs now carry clearer support caveats.
- **Release/CI hardening:** CI moved to GitHub-hosted runners, with real Windows path tests and npm/package surface coverage.

### New Features

- **feat(hud): surface usage hint for API-key users when built-in usage unavailable** (#3278)
- **Expose Cursor executor workers for autopilot team mode** (#3284)

### Bug Fixes

- **fix(session-search): strip drive colon so current-scope search finds transcripts on Windows** (#3274)
- **fix(session-search): fix Windows worktree transcript resolution + converge the encoder** (#3276)
- **fix(persistent-mode): bound thinking-only continuation loops** (#3280)
- **Fix native Windows psmux team worker launch** (#3286)
- **fix: configurable magic keyword triggers** (#3289)
- **fix state cleanup path convergence** (#3293)
- **fix(team): verify cursor worker start submission** (#3296)
- **fix(post-tool-rules-injector): honor existing skip guards** (#3297)
- **fix(jsonc): tolerate trailing commas in JSONC config files** (#3299)

### Documentation

- **docs: audit Claude Code changelog compatibility** (#3303)
- **Fix Claude Code native team guidance** (#3304)
- **docs: clarify OMC automation and SDK surfaces** (#3306)
- **Align public Claude Code guidance** (#3308)
- **docs: clarify psmux Windows team caveats** (#3312)

### CI / Tests / Maintenance

- **ci: run path-handling tests on a real Windows runner** (#3279)
- **ci: move workflows to GitHub-hosted runners** (#3287)
- **test: cover plugin MCP package surface** (#3310)

### Stats

- **19 commits since v4.14.7**
- **1 HUD/user-facing feature**
- **8+ fixes across Windows paths, team workers, JSONC, cleanup, and persistent mode**
- **Latest dev CI + Upgrade Test are green**

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.14.8
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.14.7...v4.14.8
