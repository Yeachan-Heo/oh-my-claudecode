/**
 * Routing Rules
 *
 * Defines the rules engine for model routing decisions.
 * Rules are evaluated in priority order, and the first matching rule wins.
 */
import type { RoutingRule, RoutingContext, ComplexitySignals, ComplexityTier } from './types.js';
/**
 * Default routing rules, ordered by priority (highest first)
 */
export declare const DEFAULT_ROUTING_RULES: RoutingRule[];
/**
 * Evaluate routing rules and return the first matching rule's action
 */
export declare function evaluateRules(context: RoutingContext, signals: ComplexitySignals, rules?: RoutingRule[]): {
    tier: ComplexityTier | 'EXPLICIT';
    reason: string;
    ruleName: string;
};
/**
 * Get all rules that would match for a given context (for debugging)
 */
export declare function getMatchingRules(context: RoutingContext, signals: ComplexitySignals, rules?: RoutingRule[]): RoutingRule[];
/**
 * Create a custom routing rule
 */
export declare function createRule(name: string, condition: (context: RoutingContext, signals: ComplexitySignals) => boolean, tier: ComplexityTier, reason: string, priority: number): RoutingRule;
/**
 * Merge custom rules with default rules
 */
export declare function mergeRules(customRules: RoutingRule[]): RoutingRule[];
//# sourceMappingURL=rules.d.ts.map