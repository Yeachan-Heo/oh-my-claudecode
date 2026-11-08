# Company Context MCP Interface

OMC supports a narrow, prompt-level contract for vendor-owned company context.

This contract is aimed at a specific failure mode from issue #2692: purely
prompt-directive company-context guidance is still missed in practice roughly 5%
of the time. Making the lookup an explicit configured tool call materially
reduces that miss mode at the spec layer without changing OMC runtime behavior.

This is **not** a runtime enforcement feature. It gives OMC workflows:

- a consistent tool shape,
- an explicit OMC config block,
- shared wording for when selected skills should consult that tool.

The tool invocation itself remains best-effort prompt behavior. It improves consistency, but it does **not** guarantee mathematically perfect execution.

## Scope

Use this when your organization already has an MCP server that can return internal conventions, security guidance, glossaries, or review checklists as plain reference material.

This contract does **not** create:

- a remote OMC cluster,
- a shared remote filesystem,
- a runtime hook that force-calls the tool,
- content validation, signing, or sandboxing of vendor output.

## Tool Contract

Implement exactly one tool:

```text
tool: get_company_context
input:  { query: string }
output: { context: string }
```

- `query` is a natural-language summary built by the calling workflow.
- `context` is markdown reference material.

## Trust Boundary

`context` is **informational only**.

Vendor output must be treated as quoted advisory data, not executable instructions. It must not attempt to override system prompts, tell the agent to ignore earlier instructions, or impersonate policy enforcement.

OMC skill clauses should treat the returned markdown the same way `deep-dive` treats injected trace context: useful reference material, never instruction authority.

## OMC Configuration

Configure the contract in the standard OMC config surface:

- Project: `.claude/omc.jsonc`
- User: `~/.config/claude-omc/config.jsonc`

Project config overrides user config.

```jsonc
{
  "companyContext": {
    "tool": "mcp__vendor__get_company_context",
    "onError": "warn"
  }
}
```

### Fields

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `tool` | `string` | No | Full MCP tool name to call, such as `mcp__vendor__get_company_context` |
| `onError` | `"warn" \| "silent" \| "fail"` | No | Prompt-level fallback when the configured call fails. Default: `"warn"` |

### Fallback Semantics

- Unconfigured: skip the call and continue normally.
- `warn`: briefly note the failure and continue.
- `silent`: continue with no additional note.
- `fail`: stop and surface the tool-call error.

## Workflow Trigger Stages

These are the named stages used by the built-in skill prompts:

| Skill | Stage |
|-------|-------|
| `deep-interview` | Before Phase 4 crystallizes the spec |
| `deep-dive` | At Phase 4 start, after trace synthesis is available |
| `ralplan` | Before the consensus loop begins |
| `autopilot` | At Phase 0 entry |
| `ralph` | Before each iteration picks the next story |

Each skill should build a `query` that summarizes the current task, current stage, known constraints, and relevant files or artifacts when available.

## MCP Registration

The company-context server itself is still registered through the normal MCP surfaces:

- Claude MCP configuration / `claude mcp add ...`
- the unified MCP registry that OMC syncs to Codex

This contract does not change how MCP servers are registered.

For a tiny runnable reference implementation, see:

- [`examples/vendor-mcp-server/README.md`](../examples/vendor-mcp-server/README.md)

## Residual Risk

This interface addresses the observed ~5% prompt-directive miss mode by making
the company-context lookup explicit, but it still operates at the skill-prompt
layer. The documented MUST-call clauses should meaningfully reduce that miss
rate, yet they do **not** guarantee a 0% miss rate or mathematically perfect
invocation. If you need deterministic invocation, that would require a separate
runtime enforcement design.

## Non-Goals

- Hook-level enforcement
- Prompt-injection scanning of vendor output
- Vendor signing or allowlisting
- Per-skill override matrices beyond the single configured tool and `onError`
- A bundled SDK or hosted company-context product
