<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-01-31 -->

# features

Core feature modules for oh-my-claudecode - model routing, state management, verification, and more.

## Purpose

This directory contains self-contained feature modules that enhance orchestration:
- **model-routing/** - Smart routing to Haiku/Sonnet/Opus based on task complexity
- **boulder-state/** - Plan state persistence and tracking
- **verification/** - Reusable verification protocol
- **notepad-wisdom/** - Plan-scoped learnings, decisions, issues
- **delegation-categories/** - Semantic task categorization
- **task-decomposer/** - Task breakdown for parallel execution
- **state-manager/** - Standardized state file management
- **context-injector/** - Context enhancement injection
- **background-agent/** - Background task concurrency
- **rate-limit-wait/** - API rate limit handling

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Re-exports all feature modules |
| `magic-keywords.ts` | Magic keyword detection (ultrawork, analyze, etc.) |
| `continuation-enforcement.ts` | Ensures task completion before stopping |
| `auto-update.ts` | Silent version checking and updates |
| `background-tasks.ts` | Background task execution patterns |
| `delegation-enforcer.ts` | Enforces delegation-first protocol |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `model-routing/` | Intelligent model selection based on complexity |
| `boulder-state/` | Plan state and progress persistence |
| `verification/` | Verification protocol with evidence tracking |
| `notepad-wisdom/` | Plan-scoped knowledge capture |
| `delegation-categories/` | Task categorization for model/temp selection |
| `task-decomposer/` | Task breakdown for parallelization |
| `state-manager/` | Standardized state file locations |
| `context-injector/` | Context enhancement for prompts |
| `background-agent/` | Background task management |
| `rate-limit-wait/` | Rate limit detection and waiting |
| `builtin-skills/` | Built-in skill definitions |

## For AI Agents

### Working In This Directory

#### Model Routing

Routes tasks to optimal model based on complexity signals:

```typescript
import { routeToModel, extractComplexitySignals } from './model-routing';

const signals = extractComplexitySignals(prompt);
const model = routeToModel(signals); // 'haiku' | 'sonnet' | 'opus'
```

**Signal types:**
- Code complexity (LOC, cyclomatic complexity)
- Task keywords (debug, refactor, implement)
- File count and scope
- Error/risk indicators

#### Boulder State

Persists plan state across sessions:

```typescript
import { readBoulderState, writeBoulderState, hasBoulder } from './boulder-state';

if (hasBoulder()) {
  const state = readBoulderState();
  state.progress.completedTasks++;
  writeBoulderState(state);
}
```

**State location:** `.omc/state/boulder.json`

#### Verification Protocol

Standardized verification with evidence:

```typescript
import { createVerificationContext, addEvidence, isVerified } from './verification';

const ctx = createVerificationContext(['BUILD', 'TEST', 'FUNCTIONALITY']);
addEvidence(ctx, 'BUILD', { passed: true, output: '...' });
addEvidence(ctx, 'TEST', { passed: true, output: '...' });

if (isVerified(ctx)) {
  // All checks passed
}
```

**Check types:** BUILD, TEST, LINT, FUNCTIONALITY, ARCHITECT, TODO, ERROR_FREE

#### Notepad Wisdom

Capture learnings during execution:

```typescript
import { initPlanNotepad, addLearning, addDecision } from './notepad-wisdom';

initPlanNotepad('my-plan');
addLearning('my-plan', 'The API requires auth headers');
addDecision('my-plan', 'Using JWT for authentication');
```

**Location:** `.omc/notepads/{plan-name}/`

#### Delegation Categories

Semantic categorization for model selection:

```typescript
import { categorizeTask, getCategoryConfig } from './delegation-categories';

const category = categorizeTask(prompt); // 'ultrabrain' | 'visual-engineering' | etc.
const config = getCategoryConfig(category);
// { tier: 'HIGH', temperature: 0.3, thinking: 'max' }
```

### Modification Checklist

#### When Adding a New Feature

1. Create feature directory with `index.ts`, `types.ts`, `constants.ts`
2. Export from `features/index.ts`
3. Update `docs/FEATURES.md` with API documentation
4. Update `docs/AGENTS.md` if architecture changes

#### When Modifying State File Paths

1. Update `state-manager/` for path standardization
2. Consider migration logic for existing state files
3. Document new paths in feature's README or AGENTS.md

### Common Patterns

#### Feature Module Structure

```
feature-name/
├── index.ts     # Main exports
├── types.ts     # TypeScript interfaces
├── constants.ts # Configuration constants
└── *.ts         # Implementation files
```

### Testing Requirements

```bash
npm test -- --grep "features"
```

## Dependencies

### Internal
- Features are self-contained but may import from `shared/types.ts`

### External
| Package | Purpose |
|---------|---------|
| `fs`, `path` | File operations for state persistence |

## Feature Summary

| Feature | Purpose | State Location |
|---------|---------|----------------|
| model-routing | Smart model selection | N/A (stateless) |
| boulder-state | Plan progress tracking | `.omc/state/boulder.json` |
| verification | Evidence-based verification | In-memory |
| notepad-wisdom | Knowledge capture | `.omc/notepads/` |
| delegation-categories | Task categorization | N/A (stateless) |
| task-decomposer | Parallelization | In-memory |
| state-manager | File path standardization | `.omc/state/`, `~/.omc/state/` |
| context-injector | Prompt enhancement | In-memory |
| background-agent | Concurrency control | In-memory |
| rate-limit-wait | Rate limit handling | `.omc/state/rate-limits.json` |

<!-- MANUAL: -->
