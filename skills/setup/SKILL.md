---
name: setup
description: Use first for install/update routing — sends setup, doctor, or MCP requests to the correct OMC setup flow
level: 2
---

# Setup

Use `/lazycc:setup` as the unified setup/configuration entrypoint.

## Usage

```bash
/lazycc:setup                # full setup wizard
/lazycc:setup doctor         # installation diagnostics
/lazycc:setup mcp            # MCP server configuration
/lazycc:setup wizard --local # explicit wizard path
```

## Routing

Process the request by the **first argument only** so install/setup questions land on the right flow immediately:

- No argument, `wizard`, `local`, `global`, or `--force` -> route to `/lazycc:omc-setup` with the same remaining args
- `doctor` -> route to `/lazycc:omc-doctor` with everything after the `doctor` token
- `mcp` -> route to `/lazycc:mcp-setup` with everything after the `mcp` token

Examples:

```bash
/lazycc:setup --local          # => /lazycc:omc-setup --local
/lazycc:setup doctor --json    # => /lazycc:omc-doctor --json
/lazycc:setup mcp github       # => /lazycc:mcp-setup github
```

## Notes

- `/lazycc:omc-setup`, `/lazycc:omc-doctor`, and `/lazycc:mcp-setup` remain valid compatibility entrypoints.
- Prefer `/lazycc:setup` in new documentation and user guidance.

Task: {{ARGUMENTS}}
