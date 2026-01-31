<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-01-31 -->

# tools

IDE-like capabilities for AI agents via Language Server Protocol (LSP), Abstract Syntax Tree (AST) tools, and Python REPL.

## Purpose

This directory provides agents with powerful code intelligence tools:
- **LSP Tools (12)**: Hover info, go-to-definition, find references, diagnostics, rename, code actions
- **AST Tools (2)**: Structural code search and transformation via ast-grep
- **Python REPL (1)**: Interactive Python execution for data analysis

These tools enable agents to understand and manipulate code at a semantic level, far beyond text search.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Tool registry - exports `allCustomTools`, `lspTools`, `astTools` |
| `lsp-tools.ts` | 12 LSP tool definitions (hover, definition, references, etc.) |
| `ast-tools.ts` | 2 AST tools for pattern search and replace |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `lsp/` | LSP client, server configs, utilities (see `lsp/AGENTS.md`) |
| `diagnostics/` | Directory-level diagnostics (tsc/LSP) (see `diagnostics/AGENTS.md`) |
| `python-repl/` | Python REPL tool for data analysis |

## For AI Agents

### Working In This Directory

#### LSP Tools Usage

**Basic code intelligence:**
```typescript
// Get type info at position
lsp_hover({ file: "src/index.ts", line: 10, character: 15 })

// Jump to definition
lsp_goto_definition({ file: "src/index.ts", line: 10, character: 15 })

// Find all usages
lsp_find_references({ file: "src/index.ts", line: 10, character: 15 })
```

**File/project analysis:**
```typescript
// Get file outline (all symbols)
lsp_document_symbols({ file: "src/index.ts" })

// Search symbols across workspace
lsp_workspace_symbols({ query: "createSession", file: "src/index.ts" })

// Single file diagnostics
lsp_diagnostics({ file: "src/index.ts", severity: "error" })

// PROJECT-WIDE type checking (RECOMMENDED)
lsp_diagnostics_directory({ directory: ".", strategy: "auto" })
```

**Refactoring support:**
```typescript
// Check if rename is valid
lsp_prepare_rename({ file: "src/index.ts", line: 10, character: 15 })

// Preview rename (does NOT apply changes)
lsp_rename({ file: "src/index.ts", line: 10, character: 15, newName: "newFunction" })

// Get available code actions
lsp_code_actions({ file: "src/index.ts", startLine: 10, startCharacter: 0, endLine: 10, endCharacter: 50 })
```

#### AST Tools Usage

**Pattern search with meta-variables:**
```typescript
// Find all function declarations
ast_grep_search({ pattern: "function $NAME($$$ARGS)", language: "typescript", path: "src" })

// Find console.log calls
ast_grep_search({ pattern: "console.log($MSG)", language: "typescript" })

// Find if statements
ast_grep_search({ pattern: "if ($COND) { $$$BODY }", language: "typescript" })

// Find null checks
ast_grep_search({ pattern: "$X === null", language: "typescript" })
```

**AST-aware replacement:**
```typescript
// Convert console.log to logger (dry run by default)
ast_grep_replace({
  pattern: "console.log($MSG)",
  replacement: "logger.info($MSG)",
  language: "typescript",
  dryRun: true  // Preview only
})

// Convert var to const
ast_grep_replace({
  pattern: "var $NAME = $VALUE",
  replacement: "const $NAME = $VALUE",
  language: "typescript",
  dryRun: false  // Apply changes
})
```

**Meta-variable syntax:**
- `$NAME` - Matches any single AST node (identifier, expression, etc.)
- `$$$ARGS` - Matches multiple nodes (function arguments, list items, etc.)

#### Diagnostics Strategy

The `lsp_diagnostics_directory` tool supports two strategies:

| Strategy | When Used | Speed | Accuracy |
|----------|-----------|-------|----------|
| `tsc` | tsconfig.json exists | Fast | High (full type checking) |
| `lsp` | No tsconfig.json | Slow | File-by-file |
| `auto` | Default | Varies | Picks best available |

**Recommendation**: Use `strategy: "auto"` (default) - it prefers `tsc` when available.

### Modification Checklist

#### When Adding a New Tool

1. Define tool in appropriate file (`lsp-tools.ts`, `ast-tools.ts`, or new file)
2. Export from `index.ts` (add to `allCustomTools`)
3. Update `src/mcp/omc-tools-server.ts` if exposed via MCP
4. Update `docs/REFERENCE.md` (MCP Tools section)
5. Update agent tool assignments in `src/agents/definitions.ts` if needed
6. Update `docs/CLAUDE.md` (Agent Tool Matrix) if assigned to agents

### Testing Requirements

```bash
# Test LSP tools (requires language server installed)
npm test -- --grep "lsp"

# Test AST tools
npm test -- --grep "ast"
```

### Common Patterns

**Tool Definition Structure:**
```typescript
export const myTool: ToolDefinition<{
  param: z.ZodString;
}> = {
  name: 'tool_name',
  description: 'What this tool does',
  schema: {
    param: z.string().describe('Parameter description')
  },
  handler: async (args) => {
    // Implementation
    return { content: [{ type: 'text', text: 'result' }] };
  }
};
```

**Error handling:**
```typescript
async function withLspClient(filePath, operation, fn) {
  try {
    const client = await lspClientManager.getClientForFile(filePath);
    if (!client) {
      // Return helpful installation hints
    }
    return fn(client);
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
  }
}
```

## Dependencies

### Internal
- `lsp/` - LSP client and server configurations
- `diagnostics/` - Directory diagnostics (tsc/LSP aggregator)

### External
| Package | Purpose |
|---------|---------|
| `zod` | Runtime schema validation for tool parameters |
| `@ast-grep/napi` | AST parsing and pattern matching |
| `vscode-languageserver-protocol` | LSP types |

## Tool Summary

### LSP Tools (12)

| Tool | Purpose |
|------|---------|
| `lsp_hover` | Type info/docs at position |
| `lsp_goto_definition` | Jump to symbol definition |
| `lsp_find_references` | Find all usages |
| `lsp_document_symbols` | File outline |
| `lsp_workspace_symbols` | Cross-workspace symbol search |
| `lsp_diagnostics` | Single file errors/warnings |
| `lsp_diagnostics_directory` | **Project-wide type checking** |
| `lsp_servers` | List available language servers |
| `lsp_prepare_rename` | Check if rename is valid |
| `lsp_rename` | Preview multi-file rename |
| `lsp_code_actions` | Available refactorings/fixes |
| `lsp_code_action_resolve` | Get action details |

### AST Tools (2)

| Tool | Purpose |
|------|---------|
| `ast_grep_search` | Structural code search with patterns |
| `ast_grep_replace` | AST-aware code transformation |

### Python REPL (1)

| Tool | Purpose |
|------|---------|
| `python_repl` | Execute Python code for data analysis |

## Language Support

### LSP (via language servers)
| Language | Server | Install |
|----------|--------|---------|
| TypeScript/JavaScript | typescript-language-server | `npm i -g typescript-language-server typescript` |
| Python | pylsp | `pip install python-lsp-server` |
| Rust | rust-analyzer | `rustup component add rust-analyzer` |
| Go | gopls | `go install golang.org/x/tools/gopls@latest` |
| C/C++ | clangd | System package manager |
| Java | jdtls | Eclipse JDT.LS |
| JSON | vscode-json-language-server | `npm i -g vscode-langservers-extracted` |
| HTML | vscode-html-language-server | `npm i -g vscode-langservers-extracted` |
| CSS | vscode-css-language-server | `npm i -g vscode-langservers-extracted` |
| YAML | yaml-language-server | `npm i -g yaml-language-server` |

### AST (via ast-grep)
JavaScript, TypeScript, TSX, Python, Ruby, Go, Rust, Java, Kotlin, Swift, C, C++, C#, HTML, CSS, JSON, YAML

<!-- MANUAL: -->
