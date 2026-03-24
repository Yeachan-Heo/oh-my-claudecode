---
name: setup
description: Use first for install/update routing — sends setup, doctor, or MCP requests to the correct OMC setup flow
level: 2
---

# Setup

Use `/oh-my-claudecode:setup` as the unified setup/configuration entrypoint.

## Usage

```bash
/oh-my-claudecode:setup                # full setup wizard
/oh-my-claudecode:setup doctor         # installation diagnostics
/oh-my-claudecode:setup mcp            # MCP server configuration
/oh-my-claudecode:setup wizard --local # explicit wizard path
```

## Routing

Process the request by the **first argument only** so install/setup questions land on the right flow immediately:

- No argument, `wizard`, `local`, `global`, or `--force` -> route to `/oh-my-claudecode:omc-setup` with the same remaining args
- `doctor` -> route to `/oh-my-claudecode:omc-doctor` with everything after the `doctor` token
- `mcp` -> route to `/oh-my-claudecode:mcp-setup` with everything after the `mcp` token

Examples:

```bash
/oh-my-claudecode:setup --local          # => /oh-my-claudecode:omc-setup --local
/oh-my-claudecode:setup doctor --json    # => /oh-my-claudecode:omc-doctor --json
/oh-my-claudecode:setup mcp github       # => /oh-my-claudecode:mcp-setup github
```

## Notes

- `/oh-my-claudecode:omc-setup`, `/oh-my-claudecode:omc-doctor`, and `/oh-my-claudecode:mcp-setup` remain valid compatibility entrypoints.
- Prefer `/oh-my-claudecode:setup` in new documentation and user guidance.

Task: {{ARGUMENTS}}
