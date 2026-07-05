---
name: lsp
description: "LazyCC Claude adaptation of LazyCodex lsp for diagnostics, symbols, references, and rename checks."
---

# LazyCC LSP

Invoke with `/lazycc:lsp`.

Workflow concept: `lsp`

## Purpose

Use Claude/OMC language-intelligence surfaces for diagnostics, definitions, references, symbols, and rename safety checks.

## Progressive Disclosure

1. Identify the language and the target file or symbol.
2. Check available OMC LSP or code-intelligence tools before falling back to shell commands.
3. For diagnostics, prefer the narrowest changed path first, then broaden when the failure can cross module boundaries.
4. For rename or references, inspect both language-server output and text search when confidence matters.

## Claude adaptation

- Prefer OMC MCP tools such as `lsp_diagnostics`, `lsp_diagnostics_directory`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_hover`, `lsp_find_references`, and rename helpers when available.
- Fall back to project-native commands like `tsc`, `npm run build`, or `rg` when the LSP tool is unavailable.
- Read OMC configuration rather than assuming `.codex/lsp-client.json`.

## Adapter Notes

- Codex-only concept: `mcp__lsp__*`, `.codex/lsp-client.json`, and Codex LSP tool names are not Claude runtime instructions.
- Claude alternative: OMC LSP tool names, project build/typecheck commands, and source search.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration or install language servers without explicit user approval.

## Completion

Report the exact diagnostic or symbol command used, the observed result, and any missing-server staged note.
