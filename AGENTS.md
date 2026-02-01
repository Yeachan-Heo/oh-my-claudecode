<!-- Generated: 2026-01-28 | Updated: 2026-01-31 -->

# oh-my-claudecode

Multi-agent orchestration system for Claude Code CLI, providing intelligent delegation, parallel execution, and IDE-like capabilities through LSP/AST integration.

**Version:** 3.9.4
**Purpose:** Transform Claude Code into a conductor of specialized AI agents
**Inspired by:** oh-my-zsh / oh-my-opencode

## Purpose

oh-my-claudecode enhances Claude Code with:

- **32 specialized agents** across multiple domains with 3-tier model routing (Haiku/Sonnet/Opus)
- **37 skills** for workflow automation and specialized behaviors
- **31 hooks** for event-driven execution modes and enhancements
- **15 custom tools** including 12 LSP, 2 AST, and Python REPL
- **Execution modes**: autopilot, ultrawork, ralph, ultrapilot, swarm, pipeline, ecomode
- **MCP integration** with plugin-scoped tool discovery and skill loading

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Project dependencies and npm scripts |
| `tsconfig.json` | TypeScript configuration |
| `CHANGELOG.md` | Version history and release notes |
| `docs/CLAUDE.md` | End-user orchestration instructions (installed to user projects) |
| `src/index.ts` | Main entry point - exports `createSisyphusSession()` |
| `.mcp.json` | MCP server configuration for plugin discovery |
| `.claude-plugin/plugin.json` | Claude Code plugin manifest |

## Subdirectories

| Directory | Purpose | Related AGENTS.md |
|-----------|---------|-------------------|
| `src/` | TypeScript source code - core library | `src/AGENTS.md` |
| `agents/` | Markdown prompt templates for 32 agents (see `agents/templates/` for guidelines) | - |
| `skills/` | 37 skill definitions for workflows | `skills/AGENTS.md` |
| `commands/` | 31 slash command definitions (mirrors skills) | - |
| `scripts/` | Build scripts, utilities, and automation | - |
| `docs/` | User documentation and guides | `docs/AGENTS.md` |
| `templates/` | Hook and rule templates (coding-style, testing, security, performance, git-workflow) | - |
| `benchmark/` | Performance testing framework | - |
| `bridge/` | Pre-bundled MCP server for plugin distribution | - |

## For AI Agents

### Working In This Directory

1. **Delegation-First Protocol**: You are a CONDUCTOR, not a performer. Delegate substantive work:

   | Work Type | Delegate To | Model |
   |-----------|-------------|-------|
   | Code changes | `executor` / `executor-low` / `executor-high` | sonnet/haiku/opus |
   | Analysis | `architect` / `architect-medium` / `architect-low` | opus/sonnet/haiku |
   | Search | `explore` / `explore-medium` / `explore-high` | haiku/sonnet/opus |
   | UI/UX | `designer` / `designer-low` / `designer-high` | sonnet/haiku/opus |
   | Docs | `writer` | haiku |
   | Security | `security-reviewer` / `security-reviewer-low` | opus/haiku |
   | Build errors | `build-fixer` / `build-fixer-low` | sonnet/haiku |
   | Testing | `qa-tester` / `qa-tester-high` | sonnet/opus |
   | Code review | `code-reviewer` / `code-reviewer-low` | opus/haiku |
   | TDD | `tdd-guide` / `tdd-guide-low` | sonnet/haiku |
   | Data analysis | `scientist` / `scientist-low` / `scientist-high` | sonnet/haiku/opus |

2. **LSP/AST Tools**: Use IDE-like tools for code intelligence:
   - `lsp_hover` - Type info and documentation at position
   - `lsp_goto_definition` - Jump to symbol definition
   - `lsp_find_references` - Find all usages across codebase
   - `lsp_document_symbols` - Get file outline
   - `lsp_workspace_symbols` - Search symbols across workspace
   - `lsp_diagnostics` - Get errors/warnings for single file
   - `lsp_diagnostics_directory` - Project-wide type checking (uses tsc or LSP)
   - `lsp_rename` - Preview refactoring across files
   - `lsp_code_actions` - Get available quick fixes
   - `ast_grep_search` - Structural code search with patterns
   - `ast_grep_replace` - AST-aware code transformation
   - `python_repl` - Execute Python code for data analysis

3. **Model Routing**: Match model tier to task complexity:
   - **Haiku** (LOW): Simple lookups, trivial fixes, fast searches
   - **Sonnet** (MEDIUM): Standard implementation, moderate reasoning
   - **Opus** (HIGH): Complex reasoning, architecture, debugging

### Modification Checklist

#### Cross-File Dependencies

| If you modify... | Also check/update... |
|------------------|---------------------|
| `agents/*.md` | `src/agents/definitions.ts`, `src/agents/index.ts`, `docs/REFERENCE.md` |
| `skills/*/SKILL.md` | `commands/*.md` (mirror), `scripts/build-skill-bridge.mjs` |
| `commands/*.md` | `skills/*/SKILL.md` (mirror) |
| `src/hooks/*` | `src/hooks/index.ts`, `src/hooks/bridge.ts`, related skill/command |
| Agent prompt | Tiered variants (`-low`, `-medium`, `-high`) |
| Tool definition | `src/tools/index.ts`, `src/mcp/omc-tools-server.ts`, `docs/REFERENCE.md` |
| `src/hud/*` | `commands/hud.md`, `skills/hud/SKILL.md` |
| `src/mcp/*` | `docs/REFERENCE.md` (MCP Tools section) |
| Agent tool assignments | `docs/CLAUDE.md` (Agent Tool Matrix) |
| `templates/rules/*` | `src/hooks/rules-injector/` if pattern changes |
| New execution mode | `src/hooks/*/`, `skills/*/SKILL.md`, `commands/*.md` (all three) |

#### Documentation Updates (docs/)

| If you change... | Update this docs/ file |
|------------------|----------------------|
| Agent count or agent list | `docs/REFERENCE.md` (Agents section) |
| Skill count or skill list | `docs/REFERENCE.md` (Skills section) |
| Hook count or hook list | `docs/REFERENCE.md` (Hooks System section) |
| Magic keywords | `docs/REFERENCE.md` (Magic Keywords section) |
| Architecture or skill composition | `docs/ARCHITECTURE.md` |
| Internal API or feature | `docs/FEATURES.md` |
| Breaking changes | `docs/MIGRATION.md` |
| Tiered agent design | `docs/TIERED_AGENTS_V2.md` |
| Compatibility requirements | `docs/COMPATIBILITY.md` |
| CLAUDE.md content | `docs/CLAUDE.md` (end-user instructions) |

#### Skills ↔ Commands Relationship

- `skills/` contains skill implementations with full prompts
- `commands/` contains slash command definitions that invoke skills
- Both should be kept in sync for the same functionality

#### AGENTS.md Update Requirements

When you modify files in these locations, update the corresponding AGENTS.md:

| If you change... | Update this AGENTS.md |
|------------------|----------------------|
| Root project structure, new features | `/AGENTS.md` (this file) |
| `src/**/*.ts` structure or new modules | `src/AGENTS.md` |
| `agents/*.md` files | `src/agents/AGENTS.md` (implementation details) |
| `skills/*/` directories | `skills/AGENTS.md` |
| `src/hooks/*/` directories | `src/hooks/AGENTS.md` |
| `src/tools/**/*.ts` | `src/tools/AGENTS.md` |
| `src/features/*/` modules | `src/features/AGENTS.md` |
| `src/tools/lsp/` | `src/tools/lsp/AGENTS.md` |
| `src/tools/diagnostics/` | `src/tools/diagnostics/AGENTS.md` |
| `src/agents/*.ts` | `src/agents/AGENTS.md` |

#### What to Update

- Update version number when releasing
- Update feature descriptions when functionality changes
- Update file/directory tables when structure changes
- Keep "Generated" date as original, update "Updated" date

### Testing Requirements

```bash
npm test              # Run Vitest test suite
npm run build         # TypeScript compilation
npm run lint          # ESLint checks
npm run test:coverage # Coverage report
```

### Common Patterns

```typescript
// Entry point
import { createSisyphusSession } from 'oh-my-claudecode';
const session = createSisyphusSession();

// Agent registration
import { getAgentDefinitions } from './agents/definitions';
const agents = getAgentDefinitions();

// Tool access
import { allCustomTools, lspTools, astTools } from './tools';
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code CLI                          │
├─────────────────────────────────────────────────────────────┤
│                  oh-my-claudecode (OMC)                     │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐  │
│  │   Skills    │   Agents    │    Tools    │   Hooks     │  │
│  │ (37 skills) │ (32 agents) │(LSP/AST/REPL)│ (31 hooks)  │  │
│  └─────────────┴─────────────┴─────────────┴─────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              Features Layer                             ││
│  │ model-routing | boulder-state | verification | notepad  ││
│  │ delegation-categories | task-decomposer | state-manager ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Agent Summary (32 Total)

### Base Agents (12)

| Agent | Model | Purpose |
|-------|-------|---------|
| architect | opus | Architecture, debugging, root cause analysis |
| researcher | sonnet | Documentation, external API research |
| explore | haiku | Fast codebase pattern search |
| executor | sonnet | Focused task implementation |
| designer | sonnet | UI/UX, component design |
| writer | haiku | Technical documentation |
| vision | sonnet | Image/screenshot analysis |
| critic | opus | Critical plan review |
| analyst | opus | Pre-planning requirements analysis |
| planner | opus | Strategic planning with interviews |
| qa-tester | sonnet | Interactive CLI/service testing |
| scientist | sonnet | Data analysis, hypothesis testing |

### Specialized Agents (4)

| Agent | Model | Purpose |
|-------|-------|---------|
| security-reviewer | opus | Security vulnerability detection and audits |
| build-fixer | sonnet | Build/type error resolution (multi-language) |
| tdd-guide | sonnet | Test-driven development workflow |
| code-reviewer | opus | Expert code review and quality assessment |

### Tiered Variants (16)

| Tier | Agents |
|------|--------|
| **LOW** (Haiku) | `architect-low`, `executor-low`, `researcher-low`, `designer-low`, `scientist-low`, `security-reviewer-low`, `build-fixer-low`, `tdd-guide-low`, `code-reviewer-low` (9) |
| **MEDIUM** (Sonnet) | `architect-medium`, `explore-medium` (2) |
| **HIGH** (Opus) | `executor-high`, `designer-high`, `explore-high`, `qa-tester-high`, `scientist-high` (5) |

## Execution Modes

| Mode | Trigger | Purpose |
|------|---------|---------|
| autopilot | "autopilot", "build me", "I want a" | Full autonomous execution |
| ultrawork | "ulw", "ultrawork" | Maximum parallel agent execution |
| ralph | "ralph", "don't stop until" | Persistence with architect verification |
| ultrapilot | "ultrapilot", "parallel build" | Parallel autopilot with file ownership |
| swarm | "swarm N agents" | N coordinated agents with SQLite task claiming |
| pipeline | "pipeline" | Sequential agent chaining with data passing |
| ecomode | "eco", "efficient", "budget" | Token-efficient parallel execution |

## Skills (37)

Key skills: `autopilot`, `ultrawork`, `ralph`, `ultrapilot`, `plan`, `ralplan`, `deepsearch`, `deepinit`, `frontend-ui-ux`, `git-master`, `tdd`, `security-review`, `code-review`, `research`, `analyze`, `swarm`, `pipeline`, `ecomode`, `cancel`, `learner`, `note`, `hud`, `doctor`, `omc-setup`, `mcp-setup`, `build-fix`, `ultraqa`

## LSP/AST Tools

### LSP Tools

```typescript
// IDE-like code intelligence via Language Server Protocol
lsp_hover              // Type info at position
lsp_goto_definition    // Jump to definition
lsp_find_references    // Find all usages
lsp_document_symbols   // File outline
lsp_workspace_symbols  // Cross-workspace symbol search
lsp_diagnostics        // Single file errors/warnings
lsp_diagnostics_directory  // PROJECT-WIDE type checking
lsp_servers            // List available language servers
lsp_prepare_rename     // Check if rename is valid
lsp_rename             // Preview multi-file rename
lsp_code_actions       // Available refactorings/fixes
lsp_code_action_resolve // Get action details
```

#### Supported Languages

TypeScript, Python, Rust, Go, C/C++, Java, JSON, HTML, CSS, YAML

### AST Tools

```typescript
// Structural code search/transform via ast-grep
ast_grep_search   // Pattern matching with meta-variables ($NAME, $$$ARGS)
ast_grep_replace  // AST-aware code transformation (dry-run by default)
```

#### Supported Languages

JavaScript, TypeScript, TSX, Python, Ruby, Go, Rust, Java, Kotlin, Swift, C, C++, C#, HTML, CSS, JSON, YAML

## State Files

| Path | Purpose |
|------|---------|
| `.omc/state/*.json` | Execution mode state (autopilot, swarm, etc.) |
| `.omc/notepads/` | Plan-scoped wisdom (learnings, decisions, issues) |
| `~/.omc/state/` | Global state |
| `~/.claude/.omc/` | Legacy state (auto-migrated) |

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Claude Code integration |
| `@ast-grep/napi` | AST-based code search/replace |
| `vscode-languageserver-protocol` | LSP types |
| `zod` | Runtime schema validation |
| `better-sqlite3` | Swarm task coordination |
| `chalk` | Terminal styling |
| `commander` | CLI parsing |

### Development

| Package | Purpose |
|---------|---------|
| `typescript` | Type system |
| `vitest` | Testing framework |
| `eslint` | Linting |
| `prettier` | Code formatting |

## Commands

```bash
npm run build           # Build TypeScript + skill bridge
npm run dev             # Watch mode
npm test                # Run tests
npm run test:coverage   # Coverage report
npm run lint            # ESLint
npm run sync-metadata   # Sync agent/skill metadata
```

## Hook System (31)

Key hooks in `src/hooks/`:

- `autopilot/` - Full autonomous execution
- `ralph/` - Persistence until verified
- `ultrawork/` - Parallel execution
- `ultrapilot/` - Parallel autopilot with ownership
- `swarm/` - Coordinated multi-agent
- `learner/` - Skill extraction
- `recovery/` - Error recovery
- `rules-injector/` - Rule file injection
- `think-mode/` - Enhanced reasoning

## Configuration

Settings in `~/.claude/.omc-config.json`:

```json
{
  "defaultExecutionMode": "ultrawork",
  "mcpServers": {
    "context7": { "enabled": true },
    "exa": { "enabled": true, "apiKey": "..." }
  }
}
```

<!-- MANUAL: Project-specific notes below this line are preserved on regeneration -->
