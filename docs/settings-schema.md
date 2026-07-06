# Settings Schema

This page documents OMC-owned configuration keys in the standard OMC config files:

- Project: `.claude/omc.jsonc`
- User: `~/.config/claude-omc/config.jsonc`

Project config overrides user config.

## `omc.companyContext` / `companyContext`

Issue #2692 and the PR #2694 follow-up review refer to this setting as `omc.companyContext`.
In the current OMC config surface, the same block is written as the top-level
`companyContext` object inside the OMC config files above.

```jsonc
{
  "companyContext": {
    "tool": "mcp__vendor__get_company_context",
    "onError": "warn"
  }
}
```

### Fields

| Field | Type | Required | Default | Meaning |
|-------|------|----------|---------|---------|
| `tool` | `string` | No | none | Full MCP tool name to call, for example `mcp__vendor__get_company_context` |
| `onError` | `"warn" \| "silent" \| "fail"` | No | `"warn"` | How prompt workflows react when the configured company-context tool call fails |

### Behavior

- If `companyContext` is omitted, the feature is off and workflows continue normally.
- If `tool` is configured, supported workflow prompts may call that MCP tool at their documented stage.
- `onError: "warn"` notes the failure and continues.
- `onError: "silent"` continues without an extra note.
- `onError: "fail"` stops and surfaces the tool-call error.

This remains a prompt-level workflow contract, not runtime enforcement. For the
full interface, trust boundary, trigger stages, and residual risk, see
[`company-context-interface.md`](./company-context-interface.md).

## `keywordDetector.disabled`

Opt out of auto-routing for specific keyword-detector skills without turning the
whole hook off. The UserPromptSubmit keyword detector routes shipped skill names
such as `ralph`, `autopilot`, `ralplan`, `deep-interview`, `ai-slop-cleaner`,
`tdd`, `code-review`, `security-review`, `ultrathink`, `deepsearch`, and
`analyze`. List the routed skill names to suppress here.

Read from the OMC config surface above, project `.claude/omc.jsonc` first, then
user `~/.config/claude-omc/config.jsonc` (project takes precedence).

```jsonc
{
  "keywordDetector": {
    // routed skill names to stop auto-routing; "cancel" cannot be disabled
    "disabled": ["deepsearch"]
  }
}
```

### Behavior

- Omitted or empty array: no change, every keyword routes as before.
- A listed skill is dropped before conflict resolution, so neither its magic-keyword invocation nor its mode-injection context is emitted.
- `cancel` is never disableable, even if listed: it is the emergency stop for active modes.
- To disable all keyword routing at once instead, set `OMC_SKIP_HOOKS=keyword-detector`.
