/**
 * Think Mode Switcher
 *
 * Handles model switching to high-reasoning variants when think mode is activated.
 * Supports Claude, GPT, and Gemini model families.
 *
 * Ported from oh-my-opencode's think-mode hook.
 */
import type { ThinkingConfig } from './types.js';
/**
 * Provider-specific thinking configurations.
 */
export declare const THINKING_CONFIGS: Record<string, ThinkingConfig>;
/**
 * Get the high-reasoning variant for a model ID.
 * Returns null if already high or no variant exists.
 */
export declare function getHighVariant(modelId: string): string | null;
/**
 * Check if a model is already in high variant mode.
 */
export declare function isAlreadyHighVariant(modelId: string): boolean;
/**
 * Get the thinking configuration for a provider and model.
 * Returns null if not supported or already in high mode.
 */
export declare function getThinkingConfig(providerId: string, modelId: string): ThinkingConfig | null;
/**
 * Get Claude-specific thinking configuration.
 * This is used by Claude Code for extended thinking.
 */
export declare function getClaudeThinkingConfig(budgetTokens?: number): {
    thinking: {
        type: "enabled";
        budgetTokens: number;
    };
    maxTokens: number;
};
//# sourceMappingURL=switcher.d.ts.map