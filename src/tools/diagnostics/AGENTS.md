<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-01-28 -->

# diagnostics

Project-level diagnostics via TypeScript compiler (tsc) or LSP aggregation.

## Purpose

This directory provides project-wide type checking and error detection:
- **Primary**: `tsc --noEmit` for fast, comprehensive TypeScript checking
- **Fallback**: LSP iteration when tsc is unavailable
- Powers the `lsp_diagnostics_directory` tool

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Main entry - `runDirectoryDiagnostics()` with strategy selection |
| `tsc-runner.ts` | TypeScript compiler runner - parses `tsc --noEmit` output |
| `lsp-aggregator.ts` | LSP fallback - iterates files and collects diagnostics |

## For AI Agents

### Working In This Directory

#### Strategy Selection

```typescript
// Auto-select best strategy
const result = await runDirectoryDiagnostics(directory, 'auto');

// Force specific strategy
const tscResult = await runDirectoryDiagnostics(directory, 'tsc');
const lspResult = await runDirectoryDiagnostics(directory, 'lsp');
```

**Strategy logic:**
```typescript
if (strategy === 'auto') {
  useStrategy = hasTsconfig ? 'tsc' : 'lsp';
}
```

#### TSC Runner

Uses `tsc --noEmit --pretty false` for parseable output:
```typescript
// Output format: file(line,col): error TS1234: message
const regex = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
```

**Advantages:**
- Fast (single process)
- Comprehensive (full project type checking)
- Accurate (uses tsconfig.json)

#### LSP Aggregator

Fallback that iterates through files:
```typescript
for (const file of files) {
  const client = await lspClientManager.getClientForFile(file);
  await client.openDocument(file);
  await sleep(LSP_DIAGNOSTICS_WAIT_MS); // 300ms for server processing
  const diagnostics = client.getDiagnostics(file);
}
```

**Use when:**
- No tsconfig.json
- Multi-language project
- Need per-file incremental checking

### Common Patterns

**Result format:**
```typescript
interface DirectoryDiagnosticResult {
  strategy: 'tsc' | 'lsp';
  success: boolean;
  errorCount: number;
  warningCount: number;
  diagnostics: string;  // Formatted output
  summary: string;      // Human-readable summary
}
```

### Testing Requirements

```bash
# Test with a TypeScript project
npm test -- --grep "diagnostics"
```

## Dependencies

### Internal
- `../lsp/` - LSP client for aggregation mode

### External
| Package | Purpose |
|---------|---------|
| `child_process` | Running tsc |
| `fs`, `path` | File system operations |

## Performance Comparison

| Strategy | Speed | Accuracy | Requirements |
|----------|-------|----------|--------------|
| `tsc` | Fast (~1-5s) | High | tsconfig.json |
| `lsp` | Slow (~0.3s/file) | Medium | Language server installed |

**Recommendation**: Always prefer `tsc` for TypeScript projects.

<!-- MANUAL: -->
