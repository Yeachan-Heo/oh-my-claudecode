# Agent Tiers Reference

This is the single source of truth for all agent tier information. All skill files and documentation should reference this file instead of duplicating the table.

## Tier Matrix

| Domain | LOW (Haiku) | MEDIUM (Sonnet) | HIGH (Opus) |
|--------|-------------|-----------------|-------------|
| **Analysis** | architect-low | architect-medium | architect |
| **Execution** | executor-low | executor | executor-high |
| **Search** | explore | explore-medium | explore-high |
| **Research** | researcher-low | researcher | - |
| **Frontend** | designer-low | designer | designer-high |
| **Docs** | writer | - | - |
| **Visual** | - | vision | - |
| **Planning** | - | - | planner |
| **Critique** | - | - | critic |
| **Pre-Planning** | - | - | analyst |
| **Testing** | - | qa-tester | qa-tester-high |
| **Security** | security-reviewer-low | - | security-reviewer |
| **Build** | build-fixer-low | build-fixer | - |
| **TDD** | tdd-guide-low | tdd-guide | - |
| **Code Review** | code-reviewer-low | - | code-reviewer |
| **Data Science** | scientist-low | scientist | scientist-high |

## Model Routing Guide

| Task Complexity | Tier | Model | When to Use |
|-----------------|------|-------|-------------|
| Simple | LOW | haiku | Quick lookups, simple fixes, "What does X return?" |
| Standard | MEDIUM | sonnet | Feature implementation, standard debugging, "Add validation" |
| Complex | HIGH | opus | Architecture decisions, complex debugging, "Refactor system" |

## Agent Selection by Task Type

| Task Type | Best Agent | Tier |
|-----------|------------|------|
| Quick code lookup | explore | LOW |
| Find files/patterns | explore, explore-medium | LOW/MEDIUM |
| Complex architectural search | explore-high | HIGH |
| Simple code change | executor-low | LOW |
| Feature implementation | executor | MEDIUM |
| Complex refactoring | executor-high | HIGH |
| Debug simple issue | architect-low | LOW |
| Debug complex issue | architect | HIGH |
| UI component | designer | MEDIUM |
| Complex UI system | designer-high | HIGH |
| Write docs/comments | writer | LOW |
| Research docs/APIs | researcher | MEDIUM |
| Analyze images/diagrams | vision | MEDIUM |
| Strategic planning | planner | HIGH |
| Review/critique plan | critic | HIGH |
| Pre-planning analysis | analyst | HIGH |
| Interactive CLI testing | qa-tester | MEDIUM |
| Security review | security-reviewer | HIGH |
| Quick security scan | security-reviewer-low | LOW |
| Fix build errors | build-fixer | MEDIUM |
| Simple build fix | build-fixer-low | LOW |
| TDD workflow | tdd-guide | MEDIUM |
| Quick test suggestions | tdd-guide-low | LOW |
| Code review | code-reviewer | HIGH |
| Quick code check | code-reviewer-low | LOW |
| Data analysis/stats | scientist | MEDIUM |
| Quick data inspection | scientist-low | LOW |
| Complex ML/hypothesis | scientist-high | HIGH |
| Find symbol references | explore-high | HIGH |
| Get file/workspace symbol outline | explore | LOW |
| Structural code pattern search | explore | LOW |
| Structural code transformation | executor-high | HIGH |
| Project-wide type checking | build-fixer | MEDIUM |
| Check single file for errors | executor-low | LOW |
| Data analysis / computation | scientist | MEDIUM |

## Usage

When delegating, always specify the model explicitly:

```
Task(subagent_type="oh-my-claudecode:executor",
     model="sonnet",
     prompt="...")
```

For token savings, prefer lower tiers when the task allows:
- Use `haiku` for simple lookups and quick fixes
- Use `sonnet` for standard implementation work
- Reserve `opus` for complex reasoning tasks

## MCP Tools & Agent Capabilities

### Tool Inventory

| Tool | Category | Purpose | Assigned to Agents? |
|------|----------|---------|---------------------|
| `lsp_hover` | LSP | Get type info and documentation at a code position | NO (orchestrator-direct) |
| `lsp_goto_definition` | LSP | Jump to where a symbol is defined | NO (orchestrator-direct) |
| `lsp_find_references` | LSP | Find all usages of a symbol across the codebase | YES (`explore-high` only) |
| `lsp_document_symbols` | LSP | Get outline of all symbols in a file | YES |
| `lsp_workspace_symbols` | LSP | Search for symbols by name across the workspace | YES |
| `lsp_diagnostics` | LSP | Get errors, warnings, and hints for a file | YES |
| `lsp_diagnostics_directory` | LSP | Project-level type checking (tsc --noEmit or LSP) | YES |
| `lsp_prepare_rename` | LSP | Check if a symbol can be renamed | NO (orchestrator-direct) |
| `lsp_rename` | LSP | Rename a symbol across the entire project | NO (orchestrator-direct) |
| `lsp_code_actions` | LSP | Get available refactorings and quick fixes | NO (orchestrator-direct) |
| `lsp_code_action_resolve` | LSP | Get full edit details for a code action | NO (orchestrator-direct) |
| `lsp_servers` | LSP | List available language servers and install status | NO (orchestrator-direct) |
| `ast_grep_search` | AST | Pattern-based structural code search using AST | YES |
| `ast_grep_replace` | AST | Pattern-based structural code transformation | YES (`executor-high` only) |
| `python_repl` | Data | Persistent Python REPL for data analysis and computation | YES |

### Agent Tool Matrix (MCP Tools Only)

| Agent | LSP Diagnostics | LSP Dir Diagnostics | LSP Symbols | LSP References | AST Search | AST Replace | Python REPL |
|-------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `explore` | - | - | doc + workspace | - | yes | - | - |
| `explore-medium` | - | - | doc + workspace | - | yes | - | - |
| `explore-high` | - | - | doc + workspace | yes | yes | - | - |
| `architect-low` | yes | - | - | - | - | - | - |
| `architect-medium` | yes | yes | - | - | yes | - | - |
| `architect` | yes | yes | - | - | yes | - | - |
| `executor-low` | yes | - | - | - | - | - | - |
| `executor` | yes | yes | - | - | - | - | - |
| `executor-high` | yes | yes | - | - | yes | yes | - |
| `build-fixer` | yes | yes | - | - | - | - | - |
| `build-fixer-low` | yes | yes | - | - | - | - | - |
| `tdd-guide` | yes | - | - | - | - | - | - |
| `tdd-guide-low` | yes | - | - | - | - | - | - |
| `code-reviewer` | yes | - | - | - | yes | - | - |
| `code-reviewer-low` | yes | - | - | - | - | - | - |
| `qa-tester` | yes | - | - | - | - | - | - |
| `qa-tester-high` | yes | - | - | - | - | - | - |
| `scientist-low` | - | - | - | - | - | - | yes |
| `scientist` | - | - | - | - | - | - | yes |
| `scientist-high` | - | - | - | - | - | - | yes |

### Unassigned Tools (Orchestrator-Direct)

The following 7 MCP tools are NOT assigned to any agent. Use directly when needed:

| Tool | When to Use Directly |
|------|---------------------|
| `lsp_hover` | Quick type lookups during conversation |
| `lsp_goto_definition` | Navigating to symbol definitions during analysis |
| `lsp_prepare_rename` | Checking rename feasibility before deciding on approach |
| `lsp_rename` | Safe rename operations (returns edit preview, does not auto-apply) |
| `lsp_code_actions` | Discovering available refactorings |
| `lsp_code_action_resolve` | Getting details of a specific code action |
| `lsp_servers` | Checking language server availability |

For complex rename or refactoring tasks requiring implementation, delegate to `executor-high` which can use `ast_grep_replace` for structural transformations.

### Tool Selection Guidance

- **Need file symbol outline or workspace search?** Use `lsp_document_symbols`/`lsp_workspace_symbols` via `explore`, `explore-medium`, or `explore-high`
- **Need to find all usages of a symbol?** Use `lsp_find_references` via `explore-high` (only agent with it)
- **Need structural code patterns?** (e.g., "find all functions matching X shape") Use `ast_grep_search` via `explore` family, `architect`/`architect-medium`, or `code-reviewer`
- **Need to transform code structurally?** Use `ast_grep_replace` via `executor-high` (only agent with it)
- **Need project-wide type checking?** Use `lsp_diagnostics_directory` via `architect`/`architect-medium`, `executor`/`executor-high`, or `build-fixer` family
- **Need single-file error checking?** Use `lsp_diagnostics` via many agents (see matrix)
- **Need data analysis / computation?** Use `python_repl` via `scientist` agents (all tiers)
- **Need quick type info or definition lookup?** Use `lsp_hover`/`lsp_goto_definition` directly (orchestrator-direct tools)
