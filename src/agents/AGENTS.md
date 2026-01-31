<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-01-31 -->

# agents

32 specialized AI agent definitions with 3-tier model routing for optimal cost and performance.

## Purpose

This directory defines all agents available in oh-my-claudecode:

- **12 base agents** with default model assignments
- **4 specialized agents** (security-reviewer, build-fixer, tdd-guide, code-reviewer)
- **16 tiered variants** (LOW/MEDIUM/HIGH) for smart routing
- Prompts loaded dynamically from `/agents/*.md` files
- Tools assigned based on agent specialization

## Key Files

| File | Description |
|------|-------------|
| `definitions.ts` | **Main registry** - `getAgentDefinitions()`, `omcSystemPrompt` |
| `architect.ts` | Architecture & debugging expert (Opus) |
| `executor.ts` | Focused task implementation (Sonnet) |
| `explore.ts` | Fast codebase search (Haiku) |
| `designer.ts` | UI/UX specialist (Sonnet) |
| `researcher.ts` | Documentation research (Sonnet) |
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
// Get all 32 agents
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

| Task Type | Best Agent | Model | Tools |
|-----------|------------|-------|-------|
| Complex debugging | `architect` | opus | Read, Glob, Grep, WebSearch, WebFetch |
| Quick code lookup | `architect-low` | haiku | Read, Glob, Grep |
| Standard analysis | `architect-medium` | sonnet | Read, Glob, Grep, WebSearch, WebFetch |
| Feature implementation | `executor` | sonnet | Read, Glob, Grep, Edit, Write, Bash, TodoWrite |
| Simple fixes | `executor-low` | haiku | Read, Glob, Grep, Edit, Write, Bash, TodoWrite |
| Complex refactoring | `executor-high` | opus | Read, Glob, Grep, Edit, Write, Bash, TodoWrite |
| Fast file search | `explore` | haiku | Read, Glob, Grep |
| Thorough search | `explore-medium` | sonnet | Read, Glob, Grep |
| Architectural discovery | `explore-high` | opus | Read, Glob, Grep |
| UI components | `designer` | sonnet | Read, Glob, Grep, Edit, Write, Bash |
| Simple styling | `designer-low` | haiku | Read, Glob, Grep, Edit, Write, Bash |
| Design systems | `designer-high` | opus | Read, Glob, Grep, Edit, Write, Bash |
| API documentation | `researcher` | sonnet | Read, Glob, Grep, WebSearch, WebFetch |
| Quick doc lookup | `researcher-low` | haiku | Read, Glob, Grep, WebSearch, WebFetch |
| README/docs | `writer` | haiku | Read, Glob, Grep, Edit, Write |
| Image analysis | `vision` | sonnet | Read, Glob, Grep |
| Plan review | `critic` | opus | Read, Glob, Grep |
| Requirements analysis | `analyst` | opus | Read, Glob, Grep, WebSearch |
| Strategic planning | `planner` | opus | Read, Glob, Grep, WebSearch |
| CLI testing | `qa-tester` | sonnet | Bash, Read, Grep, Glob, TodoWrite |
| Production QA | `qa-tester-high` | opus | Bash, Read, Grep, Glob, TodoWrite |
| Data analysis | `scientist` | sonnet | Read, Glob, Grep, Bash, python_repl |
| Quick data check | `scientist-low` | haiku | Read, Glob, Grep, Bash, python_repl |
| ML/hypothesis | `scientist-high` | opus | Read, Glob, Grep, Bash, python_repl |
| Security audit | `security-reviewer` | opus | Read, Grep, Glob, Bash |
| Quick security scan | `security-reviewer-low` | haiku | Read, Grep, Glob, Bash |
| Build errors | `build-fixer` | sonnet | Read, Grep, Glob, Edit, Write, Bash |
| Simple type errors | `build-fixer-low` | haiku | Read, Grep, Glob, Edit, Write, Bash |
| TDD workflow | `tdd-guide` | sonnet | Read, Grep, Glob, Edit, Write, Bash |
| Test suggestions | `tdd-guide-low` | haiku | Read, Grep, Glob, Bash |
| Code review | `code-reviewer` | opus | Read, Grep, Glob, Bash |
| Quick code check | `code-reviewer-low` | haiku | Read, Grep, Glob, Bash |

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
| Analysis | architect, architect-medium, architect-low | Debugging, architecture |
| Execution | executor, executor-low, executor-high | Code implementation |
| Search | explore, explore-medium, explore-high | Codebase exploration |
| Research | researcher, researcher-low | External documentation |
| Frontend | designer, designer-low, designer-high | UI/UX work |
| Documentation | writer | Technical writing |
| Visual | vision | Image/screenshot analysis |
| Planning | planner, analyst, critic | Strategic planning |
| Testing | qa-tester, qa-tester-high | Interactive testing |
| Security | security-reviewer, security-reviewer-low | Security audits |
| Build | build-fixer, build-fixer-low | Compilation errors |
| TDD | tdd-guide, tdd-guide-low | Test-driven development |
| Review | code-reviewer, code-reviewer-low | Code quality |
| Data | scientist, scientist-low, scientist-high | Data analysis |

<!-- MANUAL: -->
