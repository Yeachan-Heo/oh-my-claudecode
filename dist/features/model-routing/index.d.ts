/**
 * Model Routing Feature
 *
 * Intelligent model routing system that routes sub-agent tasks to appropriate
 * models (Opus/Sonnet/Haiku) based on task complexity.
 *
 * Usage:
 * ```typescript
 * import { routeTask, routeWithEscalation, adaptPromptForTier } from './model-routing';
 *
 * const decision = routeTask({
 *   taskPrompt: "Find where authentication is implemented",
 *   agentType: "explore"
 * });
 *
 * console.log(decision.tier);  // 'LOW'
 * console.log(decision.model); // 'claude-haiku-4-5-20251001'
 * ```
 */
export type { ComplexityTier, ComplexitySignals, LexicalSignals, StructuralSignals, ContextSignals, RoutingDecision, RoutingContext, RoutingConfig, RoutingRule, PromptAdaptationStrategy, } from './types.js';
export { TIER_MODELS, TIER_TO_MODEL_TYPE, DEFAULT_ROUTING_CONFIG, AGENT_CATEGORY_TIERS, COMPLEXITY_KEYWORDS, TIER_PROMPT_STRATEGIES, } from './types.js';
export { extractLexicalSignals, extractStructuralSignals, extractContextSignals, extractAllSignals, } from './signals.js';
export { calculateComplexityScore, calculateComplexityTier, scoreToTier, getScoreBreakdown, calculateConfidence, } from './scorer.js';
export { DEFAULT_ROUTING_RULES, evaluateRules, getMatchingRules, createRule, mergeRules, } from './rules.js';
export { routeTask, routeWithEscalation, getRoutingRecommendation, getModelForTask, analyzeTaskComplexity, escalateModel, canEscalate, explainRouting, quickTierForAgent, } from './router.js';
export { adaptPromptForTier, getPromptStrategy, getPromptPrefix, getPromptSuffix, createDelegationPrompt, getTaskInstructions, TIER_TASK_INSTRUCTIONS, } from './prompts/index.js';
/**
 * Convenience function to route and adapt prompt in one call
 */
export declare function routeAndAdaptTask(taskPrompt: string, agentType?: string, previousFailures?: number): {
    decision: import('./types.js').RoutingDecision;
    adaptedPrompt: string;
};
//# sourceMappingURL=index.d.ts.map