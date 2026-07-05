# LazyCodex MCP Compatibility

T10 stages LazyCodex MCP parity behind the native OMC `t` bridge. The shipped MCP config advertises only the plugin-root-relative bridge command:

```json
"args": ["${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs"]
```

The LazyCodex server inventory is exposed as metadata in `.mcp.json` so Claude can fail closed for servers that have not been smoke-tested through OMC packaging.

| LazyCodex MCP server | Status | Reason |
| --- | --- | --- |
| `grep_app` | Staged | Remote endpoint is inventoried, but not advertised until OMC bridge smoke covers remote MCP connectivity and auth-free operation. |
| `context7` | Staged | Remote endpoint is inventoried, but not advertised until OMC bridge smoke covers remote MCP connectivity and tool discovery. |
| `codegraph` | Staged | LazyCodex component runtime is generated output outside OMC source ownership; package-safe Claude bridge parity is deferred. |
| `git_bash` | Staged | LazyCodex component runtime is generated output outside OMC source ownership; mutation-capable shell bridge parity is deferred pending explicit policy gates. |
| `lsp` | Staged | OMC exposes native LSP tools through `t`; the standalone LazyCodex `lsp` MCP daemon is not advertised until daemon packaging and shutdown smoke are covered. |

Unsupported LazyCodex MCP servers must not be added under `mcpServers`. Promote a server from staged only after a non-mutating bridge/config smoke proves startup, parsing, tool discovery, path portability, and policy gating for that server.
