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
import type { DelegationCategory, CategoryConfig, ResolvedCategory, CategoryContext, ThinkingBudget } from './types.js';
import type { ComplexityTier } from '../model-routing/types.js';
/**
 * Category configuration definitions
 */
export declare const CATEGORY_CONFIGS: Record<DelegationCategory, CategoryConfig>;
/**
 * Thinking budget token limits (approximate)
 */
export declare const THINKING_BUDGET_TOKENS: Record<ThinkingBudget, number>;
/**
 * Resolve a category to its full configuration
 *
 * @param category - The category to resolve
 * @returns Resolved category with configuration
 */
export declare function resolveCategory(category: DelegationCategory): ResolvedCategory;
/**
 * Check if a string is a valid delegation category
 *
 * @param category - String to check
 * @returns True if valid category
 */
export declare function isValidCategory(category: string): category is DelegationCategory;
/**
 * Get all available categories
 *
 * @returns Array of all delegation categories
 */
export declare function getAllCategories(): DelegationCategory[];
/**
 * Get description for a category
 *
 * @param category - The category
 * @returns Human-readable description
 */
export declare function getCategoryDescription(category: DelegationCategory): string;
/**
 * Detect category from task prompt using keyword matching
 *
 * @param taskPrompt - The task description
 * @returns Best matching category or null
 */
export declare function detectCategoryFromPrompt(taskPrompt: string): DelegationCategory | null;
/**
 * Get category for a task with context
 *
 * @param context - Category resolution context
 * @returns Resolved category
 */
export declare function getCategoryForTask(context: CategoryContext): ResolvedCategory;
/**
 * Get tier from category (for backward compatibility)
 *
 * @param category - Delegation category
 * @returns Complexity tier
 */
export declare function getCategoryTier(category: DelegationCategory): ComplexityTier;
/**
 * Get temperature from category
 *
 * @param category - Delegation category
 * @returns Temperature value
 */
export declare function getCategoryTemperature(category: DelegationCategory): number;
/**
 * Get thinking budget from category
 *
 * @param category - Delegation category
 * @returns Thinking budget level
 */
export declare function getCategoryThinkingBudget(category: DelegationCategory): ThinkingBudget;
/**
 * Get thinking budget in tokens
 *
 * @param category - Delegation category
 * @returns Token budget
 */
export declare function getCategoryThinkingBudgetTokens(category: DelegationCategory): number;
/**
 * Get prompt appendix for category
 *
 * @param category - Delegation category
 * @returns Prompt appendix or empty string
 */
export declare function getCategoryPromptAppend(category: DelegationCategory): string;
/**
 * Create a delegation prompt with category-specific guidance
 *
 * @param taskPrompt - Base task prompt
 * @param category - Delegation category
 * @returns Enhanced prompt with category guidance
 */
export declare function enhancePromptWithCategory(taskPrompt: string, category: DelegationCategory): string;
export type { DelegationCategory, CategoryConfig, ResolvedCategory, CategoryContext, ThinkingBudget, } from './types.js';
//# sourceMappingURL=index.d.ts.map