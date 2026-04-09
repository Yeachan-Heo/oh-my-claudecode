<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-01-28 -->

# lsp

Language Server Protocol (LSP) client implementation providing IDE-like code intelligence.

## Purpose

This directory implements the LSP client that enables agents to:
- Connect to language servers (TypeScript, Python, Rust, Go, etc.)
- Get type information, documentation, and signatures
- Find definitions, references, and symbols
- Perform refactoring operations (rename, code actions)
- Collect diagnostics (errors, warnings)

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Module exports - re-exports client, servers, utils |
| `client.ts` | `LspClient` class - JSON-RPC 2.0 over stdio communication |
| `servers.ts` | `LSP_SERVERS` config - 10 language server definitions |
| `utils.ts` | Formatting utilities for LSP responses |

## For AI Agents

### Working In This Directory

#### LSP Client Architecture

```
┌─────────────────┐     JSON-RPC 2.0      ┌──────────────────┐
│   LspClient     │◄────────────────────►│ Language Server  │
│                 │       stdio           │ (tsserver, etc.) │
│ - connect()     │                       │                  │
│ - hover()       │                       │                  │
│ - definition()  │                       │                  │
│ - references()  │                       │                  │
│ - diagnostics() │                       │                  │
└─────────────────┘                       └──────────────────┘
```

#### Client Manager

`lspClientManager` is a singleton that pools connections:

```typescript
// Get client for a file (auto-selects appropriate server)
const client = await lspClientManager.getClientForFile('src/index.ts');

// Client is reused for same workspace/server combo
const key = `${workspaceRoot}:${serverConfig.command}`;
```

#### Server Configuration

Each server in `LSP_SERVERS` has:
```typescript
interface LspServerConfig {
  name: string;           // Human-readable name
  command: string;        // Executable command
  args: string[];         // Command arguments
  extensions: string[];   // File extensions handled
  installHint: string;    // Installation instructions
}
```

### Common Patterns

**Request/Response:**
```typescript
// All requests use JSON-RPC 2.0 format
const request = {
  jsonrpc: '2.0',
  id: this.requestId++,
  method: 'textDocument/hover',
  params: { textDocument: { uri }, position: { line, character } }
};

// Wrapped in Content-Length header
const message = `Content-Length: ${content.length}\r\n\r\n${content}`;
```

**Notification handling:**
```typescript
// Server pushes diagnostics via notifications
if (notification.method === 'textDocument/publishDiagnostics') {
  this.diagnostics.set(params.uri, params.diagnostics);
}
```

### Testing Requirements

LSP tests require language servers to be installed:
```bash
# Install TypeScript server
npm i -g typescript-language-server typescript

# Run tests
npm test -- --grep "lsp"
```

## Dependencies

### Internal
- None

### External
| Package | Purpose |
|---------|---------|
| `vscode-languageserver-protocol` | LSP type definitions |
| `child_process` | Spawning language servers |
| `fs`, `path` | File operations |

## Supported Language Servers

| Language | Server | Command | Extensions |
|----------|--------|---------|------------|
| TypeScript/JS | typescript-language-server | `typescript-language-server` | .ts, .tsx, .js, .jsx |
| Python | ty | `ty server` | .py, .pyw |
| Rust | rust-analyzer | `rust-analyzer` | .rs |
| Go | gopls | `gopls` | .go |
| C/C++ | clangd | `clangd` | .c, .h, .cpp, .cc, .hpp |
| Java | jdtls | `jdtls` | .java |
| JSON | vscode-json-language-server | `vscode-json-language-server` | .json, .jsonc |
| HTML | vscode-html-language-server | `vscode-html-language-server` | .html, .htm |
| CSS | vscode-css-language-server | `vscode-css-language-server` | .css, .scss, .less |
| YAML | yaml-language-server | `yaml-language-server` | .yaml, .yml |

<!-- MANUAL: -->
