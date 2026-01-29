<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-01-28 -->

# agents (Prompt Templates)

Markdown prompt templates for all 32 agents in oh-my-claudecode.

## Purpose

This directory contains the prompt templates that define agent behavior. Each file is a markdown document with YAML frontmatter for metadata, loaded dynamically by `src/agents/definitions.ts`.

## Key Files

| File | Agent | Model | Purpose |
|------|-------|-------|---------|
| `architect.md` | architect | opus | Architecture, debugging, root cause analysis |
| `architect-medium.md` | architect-medium | sonnet | Moderate analysis tasks |
| `architect-low.md` | architect-low | haiku | Quick code questions |
| `executor.md` | executor | sonnet | Focused task implementation |
| `executor-high.md` | executor-high | opus | Complex multi-file changes |
| `executor-low.md` | executor-low | haiku | Simple single-file tasks |
| `explore.md` | explore | haiku | Fast codebase search |
| `explore-medium.md` | explore-medium | sonnet | Thorough search with reasoning |
| `explore-high.md` | explore-high | opus | Architectural discovery |
| `designer.md` | designer | sonnet | UI/UX, component design |
| `designer-high.md` | designer-high | opus | Complex UI architecture |
| `designer-low.md` | designer-low | haiku | Simple styling tweaks |
| `researcher.md` | researcher | sonnet | Documentation research |
| `researcher-low.md` | researcher-low | haiku | Quick doc lookups |
| `writer.md` | writer | haiku | Technical documentation |
| `vision.md` | vision | sonnet | Image/screenshot analysis |
| `critic.md` | critic | opus | Critical plan review |
| `analyst.md` | analyst | opus | Pre-planning requirements |
| `planner.md` | planner | opus | Strategic planning |
| `qa-tester.md` | qa-tester | sonnet | Interactive CLI testing |
| `qa-tester-high.md` | qa-tester-high | opus | Production-ready QA |
| `scientist.md` | scientist | sonnet | Data analysis |
| `scientist-high.md` | scientist-high | opus | Complex ML/research |
| `scientist-low.md` | scientist-low | haiku | Quick data inspection |
| `security-reviewer.md` | security-reviewer | opus | Security audits |
| `security-reviewer-low.md` | security-reviewer-low | haiku | Quick security scans |
| `build-fixer.md` | build-fixer | sonnet | Build error resolution |
| `build-fixer-low.md` | build-fixer-low | haiku | Simple type errors |
| `tdd-guide.md` | tdd-guide | sonnet | TDD workflow |
| `tdd-guide-low.md` | tdd-guide-low | haiku | Test suggestions |
| `code-reviewer.md` | code-reviewer | opus | Expert code review |
| `code-reviewer-low.md` | code-reviewer-low | haiku | Quick code checks |

## For AI Agents

### Working In This Directory

#### Prompt Template Format

Each file follows this structure:
```markdown
---
name: agent-name
description: Brief description of what this agent does
model: opus | sonnet | haiku
tools: [Read, Glob, Grep, ...]
---

# Agent Name

## Role
What this agent is and its expertise.

## Instructions
Detailed instructions for how the agent should behave.

## Constraints
What the agent should NOT do.

## Output Format
How results should be formatted.
```

#### Creating a New Agent Prompt

1. Create `new-agent.md` with YAML frontmatter
2. Define clear role, instructions, and constraints
3. Reference in `src/agents/definitions.ts`

#### Tiered Variants

For model routing, create variants with complexity-appropriate instructions:

| Tier | File Suffix | Instructions Focus |
|------|-------------|-------------------|
| LOW (Haiku) | `-low.md` | Quick, simple tasks, minimal reasoning |
| MEDIUM (Sonnet) | Base file or `-medium.md` | Standard complexity |
| HIGH (Opus) | `-high.md` | Complex reasoning, deep analysis |

### Common Patterns

**Frontmatter parsing** (in `definitions.ts`):
```typescript
function loadAgentPrompt(agentName: string): string {
  const content = readFileSync(`agents/${agentName}.md`, 'utf-8');
  const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}
```

**Tool assignment by agent type:**
- Read-only: `[Read, Glob, Grep]`
- Analysis: `[Read, Glob, Grep, WebSearch, WebFetch]`
- Execution: `[Read, Glob, Grep, Edit, Write, Bash, TodoWrite]`
- Data: `[Read, Glob, Grep, Bash, python_repl]`

### Testing Requirements

Agent prompts are tested via integration tests that spawn agents and verify behavior.

## Dependencies

### Internal
- Loaded by `src/agents/definitions.ts`
- Referenced by skill definitions in `skills/`

### External
None - pure markdown files.

## Agent Categories

| Category | Agents | Common Tools |
|----------|--------|--------------|
| Analysis | architect, architect-medium, architect-low | Read, Glob, Grep, lsp_diagnostics |
| Execution | executor, executor-low, executor-high | Read, Glob, Grep, Edit, Write, Bash, lsp_diagnostics |
| Search | explore, explore-medium, explore-high | Read, Glob, Grep, ast_grep_search, lsp_document_symbols, lsp_workspace_symbols |
| Research | researcher, researcher-low | WebSearch, WebFetch |
| Frontend | designer, designer-low, designer-high | Edit, Write, Bash |
| Docs | writer | Edit, Write |
| Visual | vision | Read, Glob, Grep |
| Planning | planner, analyst, critic | Read, Glob, Grep |
| Testing | qa-tester, qa-tester-high | Bash, Read, Grep, Glob, TodoWrite, lsp_diagnostics |
| Security | security-reviewer, security-reviewer-low | Read, Grep, Bash |
| Build | build-fixer, build-fixer-low | Read, Glob, Grep, Edit, Write, Bash, lsp_diagnostics, lsp_diagnostics_directory |
| TDD | tdd-guide, tdd-guide-low | Read, Grep, Glob, Bash, lsp_diagnostics |
| Review | code-reviewer, code-reviewer-low | Read, Grep, Glob, Bash, lsp_diagnostics |
| Data | scientist, scientist-low, scientist-high | Read, Glob, Grep, Bash, python_repl |

<!-- MANUAL: -->
