/**
 * Delegation Categories
 *
 * Category-based delegation system that layers on top of ComplexityTier.
 * Provides semantic grouping with automatic tier, temperature, and thinking budget.
 *
 * Usage:
 * ```typescript
 * import { resolveCategory, getCategoryForTask } from './delegation-categories';
 *
 * // Explicit category
 * const config = resolveCategory('ultrabrain');
 * console.log(config.tier);  // 'HIGH'
 * console.log(config.temperature);  // 0.3
 *
 * // Auto-detect category from task
 * const detected = getCategoryForTask({ taskPrompt: "Design a beautiful dashboard" });
 * console.log(detected.category);  // 'visual-engineering'
 * ```
 */

import type {
  DelegationCategory,
  CategoryConfig,
  ResolvedCategory,
  CategoryContext,
  ThinkingBudget,
} from './types.js';
import type { ComplexityTier } from '../model-routing/types.js';

/**
 * Category configuration definitions
 */
export const CATEGORY_CONFIGS: Record<DelegationCategory, CategoryConfig> = {
  'visual-engineering': {
    tier: 'HIGH',
    temperature: 0.7,
    thinkingBudget: 'high',
    description: 'UI/visual reasoning, frontend work, design systems',
    promptAppend: 'Focus on visual design, user experience, and aesthetic quality. Consider accessibility, responsive design, and visual hierarchy.',
  },
  'ultrabrain': {
    tier: 'HIGH',
    temperature: 0.3,
    thinkingBudget: 'max',
    description: 'Complex reasoning, architecture decisions, deep debugging',
    promptAppend: 'Think deeply and systematically. Consider all edge cases, implications, and long-term consequences. Reason through the problem step by step.',
  },
  'artistry': {
    tier: 'MEDIUM',
    temperature: 0.9,
    thinkingBudget: 'medium',
    description: 'Creative writing, novel approaches, innovative solutions',
    promptAppend: 'Be creative and explore unconventional solutions. Think outside the box while maintaining practical feasibility.',
  },
  'quick': {
    tier: 'LOW',
    temperature: 0.1,
    thinkingBudget: 'low',
    description: 'Simple lookups, straightforward tasks, basic operations',
    promptAppend: 'Be concise and efficient. Focus on accuracy and speed.',
  },
  'writing': {
    tier: 'MEDIUM',
    temperature: 0.5,
    thinkingBudget: 'medium',
    description: 'Documentation, technical writing, content creation',
    promptAppend: 'Focus on clarity, completeness, and proper structure. Use appropriate technical terminology while remaining accessible.',
  },
  'unspecified-low': {
    tier: 'LOW',
    temperature: 0.3,
    thinkingBudget: 'low',
    description: 'Default for simple tasks when category is not specified',
  },
  'unspecified-high': {
    tier: 'HIGH',
    temperature: 0.5,
    thinkingBudget: 'high',
    description: 'Default for complex tasks when category is not specified',
  },
};

/**
 * Thinking budget token limits (approximate)
 */
export const THINKING_BUDGET_TOKENS: Record<ThinkingBudget, number> = {
  low: 1000,
  medium: 5000,
  high: 10000,
  max: 32000,
};

/**
 * Keywords for category detection.
 *
 * NOTE: These keywords overlap with COMPLEXITY_KEYWORDS in model-routing/types.ts
 * by design. The systems serve different purposes:
 * - COMPLEXITY_KEYWORDS: Determines model tier (haiku/sonnet/opus) based on complexity
 * - CATEGORY_KEYWORDS: Provides semantic context via promptAppend for enhanced guidance
 *
 * Both can match the same prompt - categories enhance the prompt with context-specific
 * instructions while model-routing independently selects the appropriate model tier.
 */
const CATEGORY_KEYWORDS: Record<DelegationCategory, string[]> = {
  'visual-engineering': [
    'ui', 'ux', 'design', 'frontend', 'component', 'style', 'css', 'visual',
    'layout', 'responsive', 'interface', 'dashboard', 'form', 'button',
    'theme', 'color', 'typography', 'animation', 'interactive',
  ],
  'ultrabrain': [
    'architecture', 'design pattern', 'refactor', 'optimize', 'debug',
    'root cause', 'analyze', 'investigate', 'complex', 'system',
    'performance', 'scalability', 'concurrency', 'race condition',
  ],
  'artistry': [
    'creative', 'innovative', 'novel', 'unique', 'original',
    'brainstorm', 'ideate', 'explore', 'imagine', 'unconventional',
  ],
  'quick': [
    'find', 'search', 'locate', 'list', 'show', 'get', 'fetch',
    'where is', 'what is', 'display', 'print', 'lookup',
  ],
  'writing': [
    'document', 'readme', 'comment', 'explain', 'describe',
    'write', 'draft', 'article', 'guide', 'tutorial', 'docs',
  ],
  'unspecified-low': [],
  'unspecified-high': [],
};

/**
 * Resolve a category to its full configuration
 *
 * @param category - The category to resolve
 * @returns Resolved category with configuration
 */
export function resolveCategory(category: DelegationCategory): ResolvedCategory {
  const config = CATEGORY_CONFIGS[category];
  if (!config) {
    throw new Error(`Unknown delegation category: ${category}`);
  }

  return {
    category,
    ...config,
  };
}

/**
 * Check if a string is a valid delegation category
 *
 * @param category - String to check
 * @returns True if valid category
 */
export function isValidCategory(category: string): category is DelegationCategory {
  return category in CATEGORY_CONFIGS;
}

/**
 * Get all available categories
 *
 * @returns Array of all delegation categories
 */
export function getAllCategories(): DelegationCategory[] {
  return Object.keys(CATEGORY_CONFIGS) as DelegationCategory[];
}

/**
 * Get description for a category
 *
 * @param category - The category
 * @returns Human-readable description
 */
export function getCategoryDescription(category: DelegationCategory): string {
  return CATEGORY_CONFIGS[category].description;
}

/**
 * Detect category from task prompt using keyword matching
 *
 * @param taskPrompt - The task description
 * @returns Best matching category or null
 */
export function detectCategoryFromPrompt(taskPrompt: string): DelegationCategory | null {
  const lowerPrompt = taskPrompt.toLowerCase();
  const scores: Record<DelegationCategory, number> = {
    'visual-engineering': 0,
    'ultrabrain': 0,
    'artistry': 0,
    'quick': 0,
    'writing': 0,
    'unspecified-low': 0,
    'unspecified-high': 0,
  };

  // Score each category based on keyword matches
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerPrompt.includes(keyword)) {
        scores[category as DelegationCategory]++;
      }
    }
  }

  // Find highest scoring category (excluding unspecified)
  let maxScore = 0;
  let bestCategory: DelegationCategory | null = null;

  for (const category of getAllCategories()) {
    if (category.startsWith('unspecified-')) continue;

    if (scores[category] > maxScore) {
      maxScore = scores[category];
      bestCategory = category;
    }
  }

  // Require at least 2 keyword matches for confidence
  if (maxScore >= 2 && bestCategory) {
    return bestCategory;
  }

  return null;
}

/**
 * Get category for a task with context
 *
 * @param context - Category resolution context
 * @returns Resolved category
 */
export function getCategoryForTask(context: CategoryContext): ResolvedCategory {
  // Explicit tier bypasses categories
  if (context.explicitTier) {
    const category: DelegationCategory = context.explicitTier === 'LOW' ? 'unspecified-low' : 'unspecified-high';
    return resolveCategory(category);
  }

  // Explicit category
  if (context.explicitCategory) {
    return resolveCategory(context.explicitCategory);
  }

  // Auto-detect from task prompt
  const detected = detectCategoryFromPrompt(context.taskPrompt);
  if (detected) {
    return resolveCategory(detected);
  }

  // Default to medium tier
  return resolveCategory('unspecified-high');
}

/**
 * Get tier from category (for backward compatibility)
 *
 * @param category - Delegation category
 * @returns Complexity tier
 */
export function getCategoryTier(category: DelegationCategory): ComplexityTier {
  return CATEGORY_CONFIGS[category].tier;
}

/**
 * Get temperature from category
 *
 * @param category - Delegation category
 * @returns Temperature value
 */
export function getCategoryTemperature(category: DelegationCategory): number {
  return CATEGORY_CONFIGS[category].temperature;
}

/**
 * Get thinking budget from category
 *
 * @param category - Delegation category
 * @returns Thinking budget level
 */
export function getCategoryThinkingBudget(category: DelegationCategory): ThinkingBudget {
  return CATEGORY_CONFIGS[category].thinkingBudget;
}

/**
 * Get thinking budget in tokens
 *
 * @param category - Delegation category
 * @returns Token budget
 */
export function getCategoryThinkingBudgetTokens(category: DelegationCategory): number {
  const budget = CATEGORY_CONFIGS[category].thinkingBudget;
  return THINKING_BUDGET_TOKENS[budget];
}

/**
 * Get prompt appendix for category
 *
 * @param category - Delegation category
 * @returns Prompt appendix or empty string
 */
export function getCategoryPromptAppend(category: DelegationCategory): string {
  return CATEGORY_CONFIGS[category].promptAppend || '';
}

/**
 * Create a delegation prompt with category-specific guidance
 *
 * @param taskPrompt - Base task prompt
 * @param category - Delegation category
 * @returns Enhanced prompt with category guidance
 */
export function enhancePromptWithCategory(
  taskPrompt: string,
  category: DelegationCategory
): string {
  const config = CATEGORY_CONFIGS[category];

  if (!config.promptAppend) {
    return taskPrompt;
  }

  return `${taskPrompt}\n\n${config.promptAppend}`;
}

// Re-export types
export type {
  DelegationCategory,
  CategoryConfig,
  ResolvedCategory,
  CategoryContext,
  ThinkingBudget,
} from './types.js';
