/**
 * Model Router
 *
 * Main routing engine that determines which model tier to use for a given task.
 * Combines signal extraction, scoring, and rules evaluation.
 */
import type { RoutingContext, RoutingDecision, RoutingConfig, ComplexityTier } from './types.js';
/**
 * Route a task to the appropriate model tier
 */
export declare function routeTask(context: RoutingContext, config?: Partial<RoutingConfig>): RoutingDecision;
/**
 * Escalate to a higher tier after failure
 */
export declare function escalateModel(currentTier: ComplexityTier): ComplexityTier;
/**
 * Check if we can escalate further
 */
export declare function canEscalate(currentTier: ComplexityTier): boolean;
/**
 * Get routing recommendation for orchestrator
 *
 * This is designed for PROACTIVE routing - the orchestrator (Opus) analyzes
 * task complexity BEFORE delegation and chooses the appropriate model tier.
 *
 * NOT reactive escalation - the right model is chosen upfront.
 */
export declare function getRoutingRecommendation(context: RoutingContext, config?: Partial<RoutingConfig>): RoutingDecision;
/**
 * Legacy: Route with escalation support
 * @deprecated Use getRoutingRecommendation for proactive routing instead.
 * The orchestrator should analyze complexity upfront, not escalate reactively.
 */
export declare function routeWithEscalation(context: RoutingContext, config?: Partial<RoutingConfig>): RoutingDecision;
/**
 * Get routing explanation for debugging/logging
 */
export declare function explainRouting(context: RoutingContext, config?: Partial<RoutingConfig>): string;
/**
 * Quick tier lookup for known agent types
 * Useful for cases where we don't need full signal analysis
 */
export declare function quickTierForAgent(agentType: string): ComplexityTier | null;
/**
 * Get recommended model for an agent based on task complexity
 *
 * This is the main entry point for orchestrator model routing.
 * The orchestrator calls this to determine which model to use when delegating.
 *
 * ALL agents are adaptive based on task complexity.
 *
 * @param agentType - The agent to delegate to
 * @param taskPrompt - The task description
 * @returns The recommended model type ('haiku', 'sonnet', or 'opus')
 */
export declare function getModelForTask(agentType: string, taskPrompt: string, config?: Partial<RoutingConfig>): {
    model: 'haiku' | 'sonnet' | 'opus';
    tier: ComplexityTier;
    reason: string;
};
/**
 * Generate a complexity analysis summary for the orchestrator
 *
 * Returns a human-readable analysis explaining the routing recommendation.
 */
export declare function analyzeTaskComplexity(taskPrompt: string, agentType?: string): {
    tier: ComplexityTier;
    model: string;
    analysis: string;
    signals: {
        wordCount: number;
        hasArchitectureKeywords: boolean;
        hasRiskKeywords: boolean;
        estimatedSubtasks: number;
        impactScope: string;
    };
};
//# sourceMappingURL=router.d.ts.map