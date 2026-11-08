<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-02-24 -->

# agents

18 specialized AI agent definitions for a wide range of tasks.

## Purpose

This directory defines all 18 agents available in oh-my-claudecode:

- Prompts loaded dynamically from `/agents/*.md` files
- Tools assigned based on agent specialization
- Model selection via explicit model parameter or routing logic

## Key Files

| File | Description |
|------|-------------|
| `definitions.ts` | **Main registry** - `getAgentDefinitions()`, `omcSystemPrompt` |
| `architect.ts` | Architecture & debugging expert (Opus) |
| `executor.ts` | Focused task implementation (Sonnet) |
| `explore.ts` | Fast codebase search (Haiku) |
| `designer.ts` | UI/UX specialist (Sonnet) |
| `document-specialist.ts` | Documentation & reference lookup (Sonnet) |
| `writer.ts` | Technical documentation (Haiku) |
| `vision.ts` | Visual/image analysis (Sonnet) |
| `critic.ts` | Critical plan review (Opus) |
| `analyst.ts` | Pre-planning analysis (Opus) |
| `planner.ts` | Strategic planning (Opus) |
| `qa-tester.ts` | CLI/service testing with tmux (Sonnet) |
| `scientist.ts` | Data analysis & hypothesis testing (Sonnet) |
| `index.ts` | Exports all agents and utilities |

## For AI Agents

### Working In This Directory

#### Understanding the Agent Registry

The main registry is in `definitions.ts`:

```typescript
// Get all 18 agents
const agents = getAgentDefinitions();

// Each agent has:
{
  name: 'architect',
  description: 'Architecture & Debugging Advisor',
  prompt: '...',  // Loaded from /agents/architect.md
  tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  model: 'opus',
  defaultModel: 'opus'
}
```

#### Agent Selection Guide

| Task Type | Best Agent | Default Model | Alternate Models |
|-----------|------------|----------------|------------------|
| Quick lookups | `architect` | sonnet | haiku for very simple |
| Complex debugging | `architect` | opus | - |
| Feature implementation | `executor` | sonnet | haiku for trivial changes |
| Complex refactoring | `executor` | opus | - |
| Fast file search | `explore` | haiku | - |
| Architectural discovery | `architect` | opus | - |
| UI components | `designer` | sonnet | haiku for simple styling |
| Design systems | `designer` | opus | - |
| API documentation | `document-specialist` | sonnet | - |
| README/docs | `writer` | haiku | - |
| Image analysis | `vision` | sonnet | - |
| Plan review | `critic` | opus | - |
| Requirements analysis | `analyst` | opus | - |
| Strategic planning | `planner` | opus | - |
| CLI testing | `qa-tester` | sonnet | - |
| Data analysis | `scientist` | sonnet | opus for complex analysis |
| Security audit | `security-reviewer` | sonnet | opus for complex review |
| Test-driven development | `test-engineer` | sonnet | - |
| Build errors | `debugger` | sonnet | - |
| TDD workflow | `test-engineer` | sonnet | - |
| Test suggestions | `test-engineer` | haiku | - |
| Code review | `code-reviewer` | opus | - |

#### Creating a New Agent

1. **Create agent file** (e.g., `new-agent.ts`):
```typescript
import type { AgentConfig } from '../shared/types.js';

export const newAgent: AgentConfig = {
  name: 'new-agent',
  description: 'What this agent does',
  prompt: '', // Will be loaded from /agents/new-agent.md
  tools: ['Read', 'Glob', 'Grep'],
  model: 'sonnet',
  defaultModel: 'sonnet'
};
```

2. **Create prompt template** at `/agents/new-agent.md`:
```markdown
---
name: new-agent
description: What this agent does
model: sonnet
tools: [Read, Glob, Grep]
---

# Agent Instructions

You are a specialized agent for...
```

3. **Add to definitions.ts**:
```typescript
import { newAgent } from './new-agent.js';

export function getAgentDefinitions() {
  return {
    // ... existing agents
    'new-agent': newAgent,
  };
}
```

4. **Export from index.ts**:
```typescript
export { newAgent } from './new-agent.js';
```

#### Creating Tiered Variants

For model routing, create LOW/MEDIUM/HIGH variants in `definitions.ts`:

```typescript
// Haiku variant for simple tasks
export const newAgentLow: AgentConfig = {
  name: 'new-agent-low',
  description: 'Quick new-agent tasks (Haiku)',
  prompt: loadAgentPrompt('new-agent-low'),
  tools: ['Read', 'Glob', 'Grep'],
  model: 'haiku',
  defaultModel: 'haiku'
};

// Opus variant for complex tasks
export const newAgentHigh: AgentConfig = {
  name: 'new-agent-high',
  description: 'Complex new-agent tasks (Opus)',
  prompt: loadAgentPrompt('new-agent-high'),
  tools: ['Read', 'Glob', 'Grep', 'WebSearch'],
  model: 'opus',
  defaultModel: 'opus'
};
```

### Modification Checklist

#### When Adding a New Agent

1. Create agent file (`src/agents/new-agent.ts`)
2. Create prompt template (`agents/new-agent.md`)
3. Add to `definitions.ts` (import + registry)
4. Export from `index.ts`
5. Update `docs/REFERENCE.md` (Agents section, count)
6. Update `docs/CLAUDE.md` (Agent Selection Guide)
7. Update root `/AGENTS.md` (Agent Summary if applicable)

#### When Modifying an Agent

1. Update agent file (`src/agents/*.ts`) if changing tools/model
2. Update prompt template (`agents/*.md`) if changing behavior
3. Update tiered variants (`-low`, `-medium`, `-high`) if applicable
4. Update `docs/REFERENCE.md` if changing agent description/capabilities
5. Update `docs/CLAUDE.md` (Agent Tool Matrix) if changing tool assignments

#### When Removing an Agent

1. Remove agent file from `src/agents/`
2. Remove prompt template from `agents/`
3. Remove from `definitions.ts` and `index.ts`
4. Update agent counts in all documentation
5. Check for skill/hook references to the removed agent

### Testing Requirements

Agents are tested via integration tests:

```bash
npm test -- --grep "agent"
```

### Common Patterns

**Prompt loading:**
```typescript
function loadAgentPrompt(agentName: string): string {
  const agentPath = join(getPackageDir(), 'agents', `${agentName}.md`);
  const content = readFileSync(agentPath, 'utf-8');
  // Strip YAML frontmatter
  const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}
```

**Tool assignment patterns:**
- Read-only agents: `['Read', 'Glob', 'Grep']`
- Analysis agents: Add `['WebSearch', 'WebFetch']`
- Execution agents: Add `['Edit', 'Write', 'Bash', 'TodoWrite']`
- Data agents: Add `['python_repl']`

## Dependencies

### Internal
- Prompts from `/agents/*.md`
- Types from `../shared/types.ts`

### External
None - pure TypeScript definitions.

## Agent Categories

| Category | Agents | Purpose |
|----------|--------|---------|
| Analysis | architect | Debugging, architecture |
| Execution | executor | Code implementation |
| Search | explore | Codebase exploration |
| Research | document-specialist | External documentation |
| Frontend | designer | UI/UX work |
| Documentation | writer | Technical writing |
| Visual | vision | Image/screenshot analysis |
| Planning | planner, analyst, critic | Strategic planning |
| Testing | qa-tester | Interactive testing |
| Security | security-reviewer | Security audits |
| TDD | test-engineer | Test-driven development |
| Review | code-reviewer | Code quality + style + performance |
| Data | scientist | Data analysis |

<!-- MANUAL:
- Legacy alias wording was removed from active prompts to keep agent naming consistent with current conventions.
- Consensus planning prompts (planner/architect/critic) now enforce RALPLAN-DR structured deliberation, including `--deliberate` high-risk checks.
-->
