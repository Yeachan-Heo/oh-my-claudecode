# Model Routing and Agent Selection (v2)

## Historical Context

Earlier versions of oh-my-claudecode used tiered agent variants (executor-low, executor-medium, executor-high) to provide cost-optimized agent selection. These have been retired in favor of a simpler approach: base agents with explicit model selection via model parameter.

## Current Architecture (v5+)

### Agent Naming

We maintain 18 base agents, each with a default model assignment:

- **architect** (default: opus) - Architecture, debugging, analysis
- **executor** (default: sonnet) - Code implementation, features
- **designer** (default: sonnet) - UI/UX components
- **planner** (default: opus) - Strategic planning
- **critic** (default: opus) - Plan/design review
- **analyst** (default: opus) - Requirements analysis
- **explore** (default: haiku) - Fast code search
- **document-specialist** (default: sonnet) - API research
- **writer** (default: haiku) - Documentation
- **vision** (default: sonnet) - Image analysis
- **qa-tester** (default: sonnet) - CLI testing
- **debugger** (default: sonnet) - Build/type errors
- **security-reviewer** (default: sonnet) - Security audit
- **code-reviewer** (default: opus) - Code quality
- **test-engineer** (default: sonnet) - Test-driven development
- **scientist** (default: sonnet) - Data analysis
- **git-master** (default: sonnet) - Git strategy
- **code-simplifier** (default: sonnet) - Code cleanup

### Model Selection Strategy

For any agent, use the model parameter to override the default:

```
executor (model="haiku")              # Cheap, fast simple changes
executor (model="sonnet")             # Balanced, standard features
executor (model="opus")               # Powerful, complex refactoring

architect (model="haiku")             # Quick questions, basic lookup
architect (model="sonnet")            # Standard debugging
architect (model="opus")              # Deep architectural analysis
```

### Cost Optimization

| Model | Best For | Cost |
|-------|----------|------|
| **haiku** | Quick lookups, trivial changes, file discovery | ~1x |
| **sonnet** | Feature work, standard debugging, balanced quality | ~10x |
| **opus** | Complex analysis, refactoring, architecture | ~50x |

Use haiku for simple tasks to reduce cost. Reserve opus for complex work where quality matters most.

### Why We Retired Tiered Variants

Previous approach had downsides:
- Proliferated agent names (18 → 54+ variants)
- Created unnecessary aliases and routing complexity
- Discouraged explicit model selection
- Made it unclear which agent was "real"
- Historical artifact from v4.0 experiment

New approach is simpler:
- Clear agent semantics - each agent has one role
- Explicit model selection via model parameter
- Predictable naming and discovery
- Easier to document and teach
- Scales better as model options change

### Migration Path

If you were using tiered variants:

```
OLD: executor-low              NEW: executor (model="haiku")
OLD: executor                  NEW: executor (model="sonnet")
OLD: executor-high             NEW: executor (model="opus")

OLD: architect-low             NEW: architect (model="haiku")
OLD: architect-medium          NEW: architect (model="sonnet")
OLD: architect                 NEW: architect (model="opus")

OLD: designer-low              NEW: designer (model="haiku")
OLD: designer                  NEW: designer (model="sonnet")
OLD: designer-high             NEW: designer (model="opus")
```

### Verification Tier Selection

For work that needs verification, match the verifier to task complexity:

| Tier | Criteria | Verifier | Model | When to Use |
|------|----------|----------|-------|-------------|
| **LIGHT** | <5 files, <100 lines, full tests | architect | haiku | Small, well-tested changes |
| **STANDARD** | Default case | architect | sonnet | Multi-file features |
| **THOROUGH** | >20 files or security/architectural | architect | opus | Major changes, security |

## Implementation Details

### Agent Definitions

See `src/agents/definitions.ts` for the agent registry. Each agent:

```typescript
{
  name: 'executor',
  defaultModel: 'sonnet',
  files: ['executor.ts'],
  description: 'Implementation and refactoring'
}
```

### Tool Assignment

Each agent gets a specific set of tools based on its role:

- **Read tools**: Read, Glob, Grep (all agents)
- **Write tools**: Edit, Write, Bash, TodoWrite (executor, designer, test-engineer)
- **Search tools**: WebSearch, WebFetch (architect, document-specialist, analyst)
- **Meta tools**: Task (only delegating agents)

See `src/agents/definitions.ts#toolsByAgent` for complete tool assignments.

### Model Routing

When an agent is invoked:
1. Check for explicit model parameter
2. Fall back to agent's defaultModel
3. Never use tiered variant names

Example routing:
```typescript
function resolveAgentModel(agentName: string, modelOverride?: string): string {
  if (modelOverride) return modelOverride;
  return getAgentDefinition(agentName).defaultModel;
}
```

## Documentation Changes

All documentation now uses base agent names with model guidance:

- **REFERENCE.md** - Agent selection guide with model recommendations
- **shared/agent-tiers.md** - Cost optimization and tier selection
- **shared/verification-tiers.md** - Verification strategy by complexity
- **AGENTS.md** - Agent catalog with tool assignments

Legacy documents kept for reference:
- **TIERED_AGENTS_V2.md** - This file, historical context
- **MIGRATION.md** - Migration notes from v4 to v5

## See Also

- `docs/REFERENCE.md` - Complete agent guide
- `docs/shared/agent-tiers.md` - Tier selection by task type
- `src/agents/definitions.ts` - Agent registry source
