# Integration Guide: Delegation Categories

How to integrate delegation categories into task delegation and orchestration.

## Quick Integration

### 1. Basic Task Delegation with Category

```typescript
import { getCategoryForTask } from './features/delegation-categories';
import { TIER_MODELS } from './features/model-routing';

async function delegateTask(taskPrompt: string, category?: string) {
  // Resolve category (with auto-detection fallback)
  const resolved = getCategoryForTask({
    taskPrompt,
    explicitCategory: category as any,
  });

  console.log(`Delegating as ${resolved.category}:`);
  console.log(`  Model: ${TIER_MODELS[resolved.tier]}`);
  console.log(`  Temperature: ${resolved.temperature}`);
  console.log(`  Thinking: ${resolved.thinkingBudget}`);

  // Enhance prompt with category guidance
  const finalPrompt = resolved.promptAppend
    ? `${taskPrompt}\n\n${resolved.promptAppend}`
    : taskPrompt;

  // Delegate to agent with category configuration
  return await delegateToAgent({
    prompt: finalPrompt,
    model: TIER_MODELS[resolved.tier],
    temperature: resolved.temperature,
    // Add thinking budget to API call config
  });
}
```

### 2. Integration with Existing Model Routing

Categories work alongside existing tier-based routing:

```typescript
import { routeTask } from './features/model-routing';
import { getCategoryForTask, getCategoryTier } from './features/delegation-categories';

async function smartDelegate(taskPrompt: string, options: {
  category?: string;
  agentType?: string;
}) {
  let tier;

  if (options.category) {
    // Use category system
    const resolved = getCategoryForTask({
      taskPrompt,
      explicitCategory: options.category as any,
    });
    tier = resolved.tier;
    console.log(`Category ${resolved.category} -> Tier ${tier}`);
  } else {
    // Use complexity-based routing
    const decision = routeTask({
      taskPrompt,
      agentType: options.agentType,
    });
    tier = decision.tier;
    console.log(`Auto-routed to tier ${tier}`);
  }

  // Both paths converge to tier-based model selection
  return await delegateWithTier(taskPrompt, tier);
}
```

### 3. Orchestrator Integration

```typescript
import { getCategoryForTask, DelegationCategory } from './features/delegation-categories';

class Orchestrator {
  async analyzeAndDelegate(task: string): Promise<void> {
    // Detect category
    const detected = getCategoryForTask({ taskPrompt: task });

    console.log(`Detected category: ${detected.category}`);

    // Route based on category
    switch (detected.category) {
      case 'visual-engineering':
        return this.delegateToDesigner(task, detected);

      case 'ultrabrain':
        return this.delegateToArchitect(task, detected);

      case 'quick':
        return this.delegateToExplorer(task, detected);

      case 'writing':
        return this.delegateToWriter(task, detected);

      default:
        return this.delegateToExecutor(task, detected);
    }
  }

  private async delegateToDesigner(task: string, config: ResolvedCategory) {
    return this.spawnAgent('designer', task, {
      tier: config.tier,
      temperature: config.temperature,
      guidance: config.promptAppend,
    });
  }

  // ... other delegation methods
}
```

## Advanced Usage

### Category-Aware Agent Selection

```typescript
import { DelegationCategory } from './features/delegation-categories';

const CATEGORY_TO_AGENT: Record<DelegationCategory, string> = {
  'visual-engineering': 'designer',
  'ultrabrain': 'architect',
  'artistry': 'designer', // High creativity
  'quick': 'explore',
  'writing': 'writer',
  'unspecified-low': 'executor',
  'unspecified-high': 'executor',
};

function selectAgentForCategory(category: DelegationCategory): string {
  return CATEGORY_TO_AGENT[category];
}
```

### Temperature Override

```typescript
import { resolveCategory } from './features/delegation-categories';

function delegateWithTemperatureOverride(
  taskPrompt: string,
  category: DelegationCategory,
  temperatureOverride?: number
) {
  const config = resolveCategory(category);

  const finalConfig = {
    ...config,
    temperature: temperatureOverride ?? config.temperature,
  };

  return delegateToAgent(taskPrompt, finalConfig);
}
```

### Thinking Budget Integration

```typescript
import { getCategoryThinkingBudgetTokens } from './features/delegation-categories';

async function delegateWithThinking(
  taskPrompt: string,
  category: DelegationCategory
) {
  const thinkingTokens = getCategoryThinkingBudgetTokens(category);

  // Use thinking budget in API call
  const response = await claudeAPI.call({
    prompt: taskPrompt,
    thinking: {
      type: 'enabled',
      budget: thinkingTokens,
    },
  });

  return response;
}
```

## Testing Integration

```typescript
import { getCategoryForTask } from './features/delegation-categories';

describe('Category Integration', () => {
  it('should detect UI tasks as visual-engineering', () => {
    const result = getCategoryForTask({
      taskPrompt: 'Design a responsive dashboard with charts'
    });

    expect(result.category).toBe('visual-engineering');
    expect(result.tier).toBe('HIGH');
  });

  it('should support explicit category override', () => {
    const result = getCategoryForTask({
      taskPrompt: 'Simple task',
      explicitCategory: 'ultrabrain'
    });

    expect(result.category).toBe('ultrabrain');
    expect(result.tier).toBe('HIGH');
    expect(result.temperature).toBe(0.3);
  });

  it('should support backward-compatible tier specification', () => {
    const result = getCategoryForTask({
      taskPrompt: 'Any task',
      explicitTier: 'LOW'
    });

    expect(result.tier).toBe('LOW');
    expect(result.category).toBe('unspecified-low');
  });
});
```

## Migration Path

### From Direct Tier Specification

**Before:**
```typescript
const decision = routeTask({ taskPrompt, explicitModel: 'opus' });
```

**After (backward compatible):**
```typescript
// Old way still works
const decision = routeTask({ taskPrompt, explicitModel: 'opus' });

// New way with categories
const config = getCategoryForTask({
  taskPrompt,
  explicitCategory: 'ultrabrain'  // More semantic
});
```

### From Agent-Specific Routing

**Before:**
```typescript
if (taskPrompt.includes('design')) {
  delegateTo('designer', taskPrompt);
} else if (taskPrompt.includes('debug')) {
  delegateTo('architect', taskPrompt);
}
```

**After:**
```typescript
const detected = getCategoryForTask({ taskPrompt });

const agentMap = {
  'visual-engineering': 'designer',
  'ultrabrain': 'architect',
  'quick': 'explore',
};

const agent = agentMap[detected.category] || 'executor';
delegateTo(agent, taskPrompt, detected);
```

## Best Practices

1. **Use Categories for Semantics**: When you know the *type* of work (design, debugging, creative)
2. **Use Tiers for Complexity**: When you know the *difficulty* level
3. **Trust Auto-Detection**: The keyword matching is reliable for common patterns
4. **Override When Needed**: Explicit category/tier always wins
5. **Enhance Prompts**: Use `promptAppend` for category-specific guidance
6. **Monitor Costs**: HIGH tier categories (ultrabrain, visual-engineering) use Opus

## Troubleshooting

### Category Not Detected

If auto-detection fails, the system defaults to `unspecified-high`. To fix:

1. Add more keywords to the task prompt
2. Use explicit category specification
3. Extend `CATEGORY_KEYWORDS` in `index.ts`

### Wrong Tier Selection

If a category maps to the wrong tier:

1. Check `CATEGORY_CONFIGS` definitions
2. Verify backward compatibility with explicit tiers
3. Consider if a new category is needed

### Temperature Too High/Low

Override temperature if category default doesn't fit:

```typescript
const config = resolveCategory('artistry');
const customConfig = { ...config, temperature: 0.5 }; // Lower creativity
```

## Examples

See `test-categories.ts` for comprehensive examples of:
- Basic resolution
- Auto-detection
- Explicit control
- Prompt enhancement
- Backward compatibility
