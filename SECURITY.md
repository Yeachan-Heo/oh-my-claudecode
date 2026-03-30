# Security Guide

This document describes the security configuration and deployment guidelines for oh-my-claudecode (OMC).

## Quick Start: Strict Mode

Enable all security features with a single environment variable:

```bash
export OMC_SECURITY=strict
```

This enables:
- Tool path restriction (AST tools confined to project root)
- Python REPL sandbox (dangerous modules/builtins blocked)
- Remote MCP server disable (Exa, Context7 not started)
- External LLM disable (Codex, Gemini workers blocked in team mode)
- Auto-update disable (prevents unverified version installs)
- Hard max iterations for persistent modes (200 cap)

## Configuration

### Environment Variable

| Variable | Values | Description |
|----------|--------|-------------|
| `OMC_SECURITY` | `strict` | Enables all security features |
| `OMC_SECURITY` | unset / other | Per-feature defaults apply (all off) |

### Config File

Granular overrides via `.claude/omc.jsonc` (project) or `~/.config/claude-omc/config.jsonc` (user):

```jsonc
{
  "security": {
    "restrictToolPaths": true,
    "pythonSandbox": true,
    "disableRemoteMcp": true,
    "disableExternalLLM": true,
    "disableAutoUpdate": true,
    "hardMaxIterations": 200
  }
}
```

### Precedence

- **Strict mode**: Config file can only **tighten** security, never relax it. Boolean flags use `||` (true stays true), `hardMaxIterations` uses `Math.min` (only decreases).
- **Non-strict mode**: Config file overrides defaults freely.

## Security Features

### Tool Path Restriction (`restrictToolPaths`)

Confines `ast_grep_search` and `ast_grep_replace` to the project root directory. Prevents reading or modifying files outside the current project.

### Python REPL Sandbox (`pythonSandbox`)

Blocks dangerous modules and builtins in the Python REPL:

**Blocked modules**: `os`, `subprocess`, `shutil`, `socket`, `ctypes`, `multiprocessing`, `webbrowser`, `http.server`, `xmlrpc.server`, `importlib`, `sys`, `io`, `pathlib`, `signal`

**Blocked builtins**: `exec`, `eval`, `compile`, `__import__`, `open`, `breakpoint`

> Note: `sys`, `io`, and `pathlib` are intentionally blocked despite limiting some legitimate REPL usage. This is a defense-in-depth tradeoff. The Python-level blocklist is not a security boundary on its own; OS-level process isolation is recommended for untrusted code execution.

### Remote MCP Disable (`disableRemoteMcp`)

Prevents Exa (web search) and Context7 (external documentation) MCP servers from starting. No queries are sent to external servers when enabled.

### External LLM Disable (`disableExternalLLM`)

Blocks Codex (OpenAI) and Gemini (Google) CLI workers from being spawned in team mode. Only Claude workers are allowed. Enforced at the `getContract()` level in the team worker contract system.

### Auto-Update Disable (`disableAutoUpdate`)

Overrides `silentAutoUpdate` in OMC config. When enabled, `isSilentAutoUpdateEnabled()` always returns `false` regardless of user config, preventing unverified npm package installs.

### Hard Max Iterations (`hardMaxIterations`)

Caps the number of iterations in persistent modes (ralph, autopilot, ultrawork). Default: 500 (non-strict), 200 (strict). Prevents runaway loops.

## Recommended Deployment Configuration

### For internal/enterprise deployment:

```bash
# Environment
export OMC_SECURITY=strict
```

```jsonc
// .claude/omc.jsonc
{
  "security": {
    "restrictToolPaths": true,
    "pythonSandbox": true,
    "disableRemoteMcp": true,
    "disableExternalLLM": true,
    "disableAutoUpdate": true,
    "hardMaxIterations": 200
  }
}
```

### Additional operational guidelines:

- Use only approved LLM APIs and AI gateways
- Use only approved MCP servers
- Do not set `"permission": {"*": "allow"}` in Claude Code settings; prefer `"ask"` mode
- Avoid hook commands (`hook.command`) — they execute with `shell: true`
- Minimize sensitive environment variables (API keys, tokens) — MCP processes inherit them
- Install OMC manually (`oh-my-claudecode install`), not via agent
- Pin to a verified version with `"disableAutoUpdate": true`
- Clone repositories only from trusted sources — `.mcp.json` files are auto-loaded by Claude Code

## Known Limitations

These are structural characteristics that cannot be fully resolved by configuration:

| Limitation | Severity | Mitigation |
|------------|----------|------------|
| No OS-level process sandbox | Medium | Python blocklist provides defense-in-depth; recommend OS-level isolation for untrusted code |
| No security boundary between agents | Medium | Agents share filesystem and MCP access; env vars are allowlisted for worker processes |
| Background agent monitoring gap | Low | Users cannot watch all parallel agents in team mode; operational acceptance |

## Reporting Security Issues

If you discover a security vulnerability, please report it via [GitHub Issues](https://github.com/Yeachan-Heo/oh-my-claudecode/issues) with the `security` label.
