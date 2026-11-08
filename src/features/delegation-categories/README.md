# Delegation Categories

Category-based delegation system that layers on top of the ComplexityTier system. Provides semantic grouping with automatic tier, temperature, and thinking budget configuration.

## Overview

Categories provide a high-level semantic interface for delegation while maintaining full compatibility with the underlying ComplexityTier system. Each category maps to:
- **Complexity Tier**: LOW, MEDIUM, or HIGH (which determines the model)
- **Temperature**: Controls randomness/creativity (0-1)
- **Thinking Budget**: Token budget for extended thinking
- **Prompt Appendix**: Category-specific guidance

## Categories

### visual-engineering
**Tier:** HIGH | **Temperature:** 0.7 | **Thinking:** high (10k tokens)

For UI/visual reasoning, frontend work, design systems, and aesthetic decisions.

**Best for:**
- Component design and styling
- Layout and responsive design
- Visual hierarchy and accessibility
- Animation and interaction design

**Example:**
```typescript
const config = resolveCategory('visual-engineering');
// -> tier: HIGH, temperature: 0.7, model: opus
```

### ultrabrain
**Tier:** HIGH | **Temperature:** 0.3 | **Thinking:** max (32k tokens)

For complex reasoning, architecture decisions, deep debugging, and systematic analysis.

**Best for:**
- Architecture and design patterns
- Complex debugging and root cause analysis
- Performance optimization
- Concurrency and race condition analysis

**Example:**
```typescript
const config = resolveCategory('ultrabrain');
// -> tier: HIGH, temperature: 0.3, model: opus, max thinking
```

### artistry
**Tier:** MEDIUM | **Temperature:** 0.9 | **Thinking:** medium (5k tokens)

For creative writing, novel approaches, and innovative solutions.

**Best for:**
- Creative problem-solving
- Novel approaches to challenges
- Brainstorming and ideation
- Exploratory design

**Example:**
```typescript
const config = resolveCategory('artistry');
// -> tier: MEDIUM, temperature: 0.9, model: sonnet
```

### quick
**Tier:** LOW | **Temperature:** 0.1 | **Thinking:** low (1k tokens)

For simple lookups, straightforward tasks, and basic operations.

**Best for:**
- Finding files or functions
- Simple search operations
- Basic information retrieval
- Quick status checks

**Example:**
```typescript
const config = resolveCategory('quick');
// -> tier: LOW, temperature: 0.1, model: haiku
```

### writing
**Tier:** MEDIUM | **Temperature:** 0.5 | **Thinking:** medium (5k tokens)

For documentation, technical writing, and content creation.

**Best for:**
- API documentation
- README files
- Technical guides and tutorials
- Code comments and explanations

**Example:**
```typescript
const config = resolveCategory('writing');
// -> tier: MEDIUM, temperature: 0.5, model: sonnet
```

### unspecified-low / unspecified-high
**Tiers:** LOW / HIGH | **Default categories**

Used when no specific category is detected or when explicit tiers are provided.

## Usage

### Basic Usage

```typescript
import { resolveCategory } from './delegation-categories';

// Resolve a category to full configuration
const config = resolveCategory('ultrabrain');

console.log(config.tier);            // 'HIGH'
console.log(config.temperature);     // 0.3
console.log(config.thinkingBudget);  // 'max'
console.log(config.promptAppend);    // Category-specific guidance
```

### Auto-Detection

```typescript
import { getCategoryForTask } from './delegation-categories';

// Auto-detect category from task prompt
const detected = getCategoryForTask({
  taskPrompt: 'Design a beautiful dashboard with responsive layout'
});

console.log(detected.category);  // 'visual-engineering'
console.log(detected.tier);      // 'HIGH'
```

### Explicit Control

```typescript
// Explicit category
const explicitCat = getCategoryForTask({
  taskPrompt: 'Some task',
  explicitCategory: 'ultrabrain'
});

// Explicit tier (bypasses categories)
const explicitTier = getCategoryForTask({
  taskPrompt: 'Some task',
  explicitTier: 'LOW'  // Uses 'unspecified-low' category
});
```

### Prompt Enhancement

```typescript
import { enhancePromptWithCategory } from './delegation-categories';

const basePrompt = 'Create a login form';
const enhanced = enhancePromptWithCategory(basePrompt, 'visual-engineering');

// Appends category-specific guidance about UX, accessibility, etc.
```

### Utility Functions

```typescript
import {
  isValidCategory,
  getAllCategories,
  getCategoryDescription,
  getCategoryTier,
  getCategoryTemperature,
  getCategoryThinkingBudget,
  getCategoryThinkingBudgetTokens,
} from './delegation-categories';

// Validation
if (isValidCategory('ultrabrain')) {
  // Valid category
}

// Get all categories
const categories = getAllCategories();
// -> ['visual-engineering', 'ultrabrain', 'artistry', ...]

// Get description
const desc = getCategoryDescription('ultrabrain');
// -> 'Complex reasoning, architecture decisions, deep debugging'

// Extract specific properties
const tier = getCategoryTier('ultrabrain');        // 'HIGH'
const temp = getCategoryTemperature('artistry');   // 0.9
const budget = getCategoryThinkingBudget('quick'); // 'low'
const tokens = getCategoryThinkingBudgetTokens('ultrabrain'); // 32000
```

## Backward Compatibility

The category system is **fully compatible** with direct tier specification:

```typescript
// Old way (still works)
const config = getCategoryForTask({
  taskPrompt: 'Task',
  explicitTier: 'HIGH'  // Direct tier
});

// New way (preferred)
const config2 = getCategoryForTask({
  taskPrompt: 'Task',
  explicitCategory: 'ultrabrain'  // Semantic category
});

// Both resolve to ComplexityTier
console.log(config.tier);   // 'HIGH'
console.log(config2.tier);  // 'HIGH'
```

## Architecture

```
CategoryContext
  └─> detectCategoryFromPrompt()
       └─> resolveCategory()
            └─> CategoryConfig { tier, temperature, thinkingBudget }
                 └─> ComplexityTier (LOW/MEDIUM/HIGH)
                      └─> Model Selection (haiku/sonnet/opus)
```

Categories are a **semantic layer** that maps to the underlying tier system. The tier system handles model selection, so categories don't bypass or replace it—they enhance it.

## Testing

Run the test suite:

```bash
npx tsx src/features/delegation-categories/test-categories.ts
```

Tests cover:
- Category resolution
- Validation
- Auto-detection from prompts
- Explicit category/tier handling
- Backward compatibility
- Prompt enhancement

## Integration Points

This system integrates with:
- **Model Routing** (`src/features/model-routing/`): Categories resolve to ComplexityTier
- **Task Delegation**: Categories can be specified when delegating to agents
- **Orchestration**: Orchestrator can use categories for semantic routing

## Design Decisions

1. **Layer, Don't Replace**: Categories sit on top of tiers, not instead of
2. **Semantic Grouping**: Categories provide meaningful names for common patterns
3. **Full Configuration**: Each category bundles tier + temperature + thinking budget
4. **Backward Compatible**: Direct tier specification still works
5. **Auto-Detection**: Keyword matching for convenience, explicit control when needed

## Future Extensions

Potential enhancements:
- Agent-specific category defaults
- User-defined custom categories
- Category learning from successful delegations
- Dynamic category detection using model analysis
