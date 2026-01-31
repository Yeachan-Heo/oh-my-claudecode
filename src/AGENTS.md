<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-01-31 -->

# src

TypeScript source code for oh-my-claudecode - the core library that powers multi-agent orchestration.

## Purpose

This directory contains all TypeScript source code organized into modules:

- **agents/** - 32 specialized AI agent definitions with tiered variants
- **tools/** - 15 LSP/AST/REPL tools for IDE-like capabilities
- **hooks/** - 31 event-driven behaviors for execution modes
- **features/** - Core features (model routing, state management, verification)
- **config/** - Configuration loading and validation
- **commands/** - Command expansion utilities
- **mcp/** - MCP server integration

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Main entry point - exports `createSisyphusSession()` |
| `shared/types.ts` | Shared TypeScript types used across modules |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `agents/` | 32 agent definitions with prompts and tools (see `agents/AGENTS.md`) |
| `tools/` | 15 LSP, AST, and Python REPL tools (see `tools/AGENTS.md`) |
| `hooks/` | 31 hooks for execution modes (see `hooks/AGENTS.md`) |
| `features/` | Core features like model routing, state (see `features/AGENTS.md`) |
| `config/` | Configuration loading (`loader.ts`) |
| `commands/` | Command expansion utilities |
| `mcp/` | MCP server configuration |
| `cli/` | CLI entry points (`index.ts`, `analytics.ts`) |
| `hud/` | Heads-up display components |
| `installer/` | Installation system |
| `analytics/` | Usage analytics collection |
| `__tests__/` | Test files |

## For AI Agents

### Working In This Directory

1. **Module Organization**: Each major feature has its own directory with:
   - `index.ts` - Main exports
   - `types.ts` - TypeScript interfaces
   - Supporting files as needed

2. **Entry Point Pattern**:
   ```typescript
   // Main export in index.ts
   export { createSisyphusSession } from './session';
   export { lspTools, astTools, allCustomTools } from './tools';
   export { getAgentDefinitions, omcSystemPrompt } from './agents/definitions';
   ```

3. **Tool Registration**: Custom tools are registered in `tools/index.ts`:

   ```typescript
   export const allCustomTools = [
     ...lspTools,      // 12 LSP tools
     ...astTools,      // 2 AST tools
     pythonReplTool    // 1 REPL tool (15 total)
   ];
   ```

4. **Agent Registration**: Agents defined in `agents/definitions.ts`:
   ```typescript
   export function getAgentDefinitions(): Record<string, AgentConfig> {
     return {
       architect: architectAgent,
       executor: executorAgent,
       // ... all 32 agents
     };
   }
   ```

### Testing Requirements

- Test files are in `__tests__/` with pattern `*.test.ts`
- Run `npm test -- --grep "module-name"` for specific modules
- Verify type safety with `npm run build` after changes
- Use `lsp_diagnostics_directory` tool for project-wide type checking

### Common Patterns

#### Creating a New Agent

1. Add agent file in `agents/` (e.g., `new-agent.ts`)
2. Export from `agents/index.ts`
3. Add to `getAgentDefinitions()` in `agents/definitions.ts`
4. Create prompt template in `/agents/new-agent.md`
5. Update `docs/REFERENCE.md` (Agents section) with new agent

#### Adding a New Hook

1. Create directory in `hooks/` (e.g., `new-hook/`)
2. Add `index.ts`, `types.ts`, `constants.ts`
3. Export from `hooks/index.ts`
4. Update `docs/REFERENCE.md` (Hooks System section) with new hook

#### Adding a New Tool

1. Create tool definition with Zod schema
2. Add to appropriate tools file (`lsp-tools.ts`, `ast-tools.ts`)
3. Export from `tools/index.ts`
4. Update `docs/REFERENCE.md` if user-facing tool

#### Adding a New Feature

1. Create feature directory in `features/`
2. Export from `features/index.ts`
3. Update `docs/FEATURES.md` with API documentation

#### TypeScript Conventions

- Use strict mode (`noImplicitAny`, `strictNullChecks`)
- Prefer interfaces over type aliases for public APIs
- Use barrel exports (`index.ts`) for each module
- File size: 200-400 lines typical, 800 max
- Use Zod for runtime input validation (see `templates/rules/coding-style.md`)

## Dependencies

### Internal
- Uses types from `shared/types.ts`
- Imports agent prompts from `/agents/*.md`
- Loads skills from `/skills/*.md`

### External

Key packages by module: `zod` (tools, features), `@ast-grep/napi` (tools/ast), `vscode-languageserver-protocol` (tools/lsp), `better-sqlite3` (hooks/swarm), `chalk` (cli, hud). See root AGENTS.md for full dependency list.

## Module Dependency Graph

```
index.ts
├── agents/definitions.ts → agents/*.ts → /agents/*.md (prompts)
├── tools/index.ts
│   ├── lsp-tools.ts → lsp/*.ts
│   ├── ast-tools.ts
│   └── python-repl/
├── hooks/index.ts → hooks/*/*.ts
├── features/index.ts
│   ├── model-routing/
│   ├── boulder-state/
│   ├── verification/
│   └── ...
├── config/loader.ts
└── mcp/servers.ts
```

<!-- MANUAL: -->
