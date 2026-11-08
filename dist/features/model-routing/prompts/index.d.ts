/**
 * Tiered Prompt Adaptations
 *
 * Provides model-specific prompt adaptations for Opus, Sonnet, and Haiku.
 * Each tier has prompts optimized for that model's capabilities.
 */
import type { ComplexityTier, PromptAdaptationStrategy } from '../types.js';
export * from './opus.js';
export * from './sonnet.js';
export * from './haiku.js';
/**
 * Adapt a prompt for a specific complexity tier
 */
export declare function adaptPromptForTier(prompt: string, tier: ComplexityTier): string;
/**
 * Get the prompt strategy for a tier
 */
export declare function getPromptStrategy(tier: ComplexityTier): PromptAdaptationStrategy;
/**
 * Get prompt prefix for a tier
 */
export declare function getPromptPrefix(tier: ComplexityTier): string;
/**
 * Get prompt suffix for a tier
 */
export declare function getPromptSuffix(tier: ComplexityTier): string;
/**
 * Create a delegation prompt with tier-appropriate framing
 */
export declare function createDelegationPrompt(tier: ComplexityTier, task: string, context: {
    deliverables?: string;
    successCriteria?: string;
    context?: string;
    mustDo?: string[];
    mustNotDo?: string[];
    requiredSkills?: string[];
    requiredTools?: string[];
}): string;
/**
 * Tier-specific instructions for common task types
 */
export declare const TIER_TASK_INSTRUCTIONS: Record<ComplexityTier, Record<string, string>>;
/**
 * Get task-specific instructions for a tier
 */
export declare function getTaskInstructions(tier: ComplexityTier, taskType: string): string;
//# sourceMappingURL=index.d.ts.map