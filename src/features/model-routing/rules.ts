/**
 * Routing Rules
 *
 * Defines the rules engine for model routing decisions.
 * Rules are evaluated in priority order, and the first matching rule wins.
 */

import type {
  RoutingRule,
  RoutingContext,
  ComplexitySignals,
  ComplexityTier,
} from './types.js';

/**
 * Default routing rules, ordered by priority (highest first)
 */
export const DEFAULT_ROUTING_RULES: RoutingRule[] = [
  // ============ Override Rules (Highest Priority) ============

  {
    name: 'explicit-model-specified',
    condition: (ctx) => ctx.explicitModel !== undefined,
    action: { tier: 'EXPLICIT' as any, reason: 'User specified model explicitly' },
    priority: 100,
  },

  // NOTE: ALL agents are now ADAPTIVE based on task complexity
  // This includes: architect, planner, critic, analyst, explore, writer, etc.

  // ============ Advisory Agent Adaptive Rules ============

  // Architect: Simple lookups → LOW, tracing → MEDIUM, debugging/architecture → HIGH
  // Higher priority (85) to override generic rules like short-local-change
  {
    name: 'architect-complex-debugging',
    condition: (ctx, signals) =>
      ctx.agentType === 'architect' &&
      (signals.lexical.hasDebuggingKeywords ||
       signals.lexical.hasArchitectureKeywords ||
       signals.lexical.hasRiskKeywords),
    action: { tier: 'HIGH', reason: 'Architect: Complex debugging/architecture decision' },
    priority: 85,
  },

  {
    name: 'architect-simple-lookup',
    condition: (ctx, signals) =>
      ctx.agentType === 'architect' &&
      signals.lexical.hasSimpleKeywords &&
      !signals.lexical.hasDebuggingKeywords &&
      !signals.lexical.hasArchitectureKeywords &&
      !signals.lexical.hasRiskKeywords,
    action: { tier: 'LOW', reason: 'Architect: Simple lookup query' },
    priority: 80,
  },

  // Planner: Simple breakdown → LOW, moderate planning → MEDIUM, cross-domain → HIGH
  {
    name: 'planner-simple-breakdown',
    condition: (ctx, signals) =>
      ctx.agentType === 'planner' &&
      signals.structural.estimatedSubtasks <= 3 &&
      !signals.lexical.hasRiskKeywords &&
      signals.structural.impactScope === 'local',
    action: { tier: 'LOW', reason: 'Planner: Simple task breakdown' },
    priority: 75,
  },

  {
    name: 'planner-strategic-planning',
    condition: (ctx, signals) =>
      ctx.agentType === 'planner' &&
      (signals.structural.impactScope === 'system-wide' ||
       signals.lexical.hasArchitectureKeywords ||
       signals.structural.estimatedSubtasks > 10),
    action: { tier: 'HIGH', reason: 'Planner: Cross-domain strategic planning' },
    priority: 75,
  },

  // Critic: Checklist → LOW, gap analysis → MEDIUM, adversarial review → HIGH
  {
    name: 'critic-checklist-review',
    condition: (ctx, signals) =>
      ctx.agentType === 'critic' &&
      signals.lexical.wordCount < 30 &&
      !signals.lexical.hasRiskKeywords,
    action: { tier: 'LOW', reason: 'Critic: Checklist verification' },
    priority: 75,
  },

  {
    name: 'critic-adversarial-review',
    condition: (ctx, signals) =>
      ctx.agentType === 'critic' &&
      (signals.lexical.hasRiskKeywords || signals.structural.impactScope === 'system-wide'),
    action: { tier: 'HIGH', reason: 'Critic: Adversarial review for critical system' },
    priority: 75,
  },

  // Analyst: Simple impact → LOW, dependency mapping → MEDIUM, risk analysis → HIGH
  {
    name: 'analyst-simple-impact',
    condition: (ctx, signals) =>
      ctx.agentType === 'analyst' &&
      signals.structural.impactScope === 'local' &&
      !signals.lexical.hasRiskKeywords,
    action: { tier: 'LOW', reason: 'Analyst: Simple impact analysis' },
    priority: 75,
  },

  {
    name: 'analyst-risk-analysis',
    condition: (ctx, signals) =>
      ctx.agentType === 'analyst' &&
      (signals.lexical.hasRiskKeywords || signals.structural.impactScope === 'system-wide'),
    action: { tier: 'HIGH', reason: 'Analyst: Risk analysis and unknown-unknowns detection' },
    priority: 75,
  },

  // ============ Task-Based Rules ============

  {
    name: 'architecture-system-wide',
    condition: (ctx, signals) =>
      signals.lexical.hasArchitectureKeywords &&
      signals.structural.impactScope === 'system-wide',
    action: { tier: 'HIGH', reason: 'Architectural decisions with system-wide impact' },
    priority: 70,
  },

  {
    name: 'security-domain',
    condition: (ctx, signals) =>
      signals.structural.domainSpecificity === 'security',
    action: { tier: 'HIGH', reason: 'Security-related tasks require careful reasoning' },
    priority: 70,
  },

  {
    name: 'difficult-reversibility-risk',
    condition: (ctx, signals) =>
      signals.structural.reversibility === 'difficult' &&
      signals.lexical.hasRiskKeywords,
    action: { tier: 'HIGH', reason: 'High-risk, difficult-to-reverse changes' },
    priority: 70,
  },

  {
    name: 'deep-debugging',
    condition: (ctx, signals) =>
      signals.lexical.hasDebuggingKeywords &&
      signals.lexical.questionDepth === 'why',
    action: { tier: 'HIGH', reason: 'Root cause analysis requires deep reasoning' },
    priority: 65,
  },

  {
    name: 'complex-multi-step',
    condition: (ctx, signals) =>
      signals.structural.estimatedSubtasks > 5 &&
      signals.structural.crossFileDependencies,
    action: { tier: 'HIGH', reason: 'Complex multi-step task with cross-file changes' },
    priority: 60,
  },

  {
    name: 'simple-search-query',
    condition: (ctx, signals) =>
      signals.lexical.hasSimpleKeywords &&
      signals.structural.estimatedSubtasks <= 1 &&
      signals.structural.impactScope === 'local' &&
      !signals.lexical.hasArchitectureKeywords &&
      !signals.lexical.hasDebuggingKeywords,
    action: { tier: 'LOW', reason: 'Simple search or lookup task' },
    priority: 60,
  },

  {
    name: 'short-local-change',
    condition: (ctx, signals) =>
      signals.lexical.wordCount < 50 &&
      signals.structural.impactScope === 'local' &&
      signals.structural.reversibility === 'easy' &&
      !signals.lexical.hasRiskKeywords,
    action: { tier: 'LOW', reason: 'Short, local, easily reversible change' },
    priority: 55,
  },

  {
    name: 'moderate-complexity',
    condition: (ctx, signals) =>
      signals.structural.estimatedSubtasks > 1 &&
      signals.structural.estimatedSubtasks <= 5,
    action: { tier: 'MEDIUM', reason: 'Moderate complexity with multiple subtasks' },
    priority: 50,
  },

  {
    name: 'module-level-work',
    condition: (ctx, signals) =>
      signals.structural.impactScope === 'module',
    action: { tier: 'MEDIUM', reason: 'Module-level changes' },
    priority: 45,
  },

  // ============ Default Rule ============

  {
    name: 'default-medium',
    condition: () => true,
    action: { tier: 'MEDIUM', reason: 'Default tier for unclassified tasks' },
    priority: 0,
  },
];

/**
 * Evaluate routing rules and return the first matching rule's action
 */
export function evaluateRules(
  context: RoutingContext,
  signals: ComplexitySignals,
  rules: RoutingRule[] = DEFAULT_ROUTING_RULES
): { tier: ComplexityTier | 'EXPLICIT'; reason: string; ruleName: string } {
  // Sort rules by priority (highest first)
  const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sortedRules) {
    if (rule.condition(context, signals)) {
      return {
        tier: rule.action.tier,
        reason: rule.action.reason,
        ruleName: rule.name,
      };
    }
  }

  // Should never reach here due to default rule, but just in case
  return {
    tier: 'MEDIUM',
    reason: 'Fallback to medium tier',
    ruleName: 'fallback',
  };
}

/**
 * Get all rules that would match for a given context (for debugging)
 */
export function getMatchingRules(
  context: RoutingContext,
  signals: ComplexitySignals,
  rules: RoutingRule[] = DEFAULT_ROUTING_RULES
): RoutingRule[] {
  return rules.filter(rule => rule.condition(context, signals));
}

/**
 * Create a custom routing rule
 */
export function createRule(
  name: string,
  condition: (context: RoutingContext, signals: ComplexitySignals) => boolean,
  tier: ComplexityTier,
  reason: string,
  priority: number
): RoutingRule {
  return {
    name,
    condition,
    action: { tier, reason },
    priority,
  };
}

/**
 * Merge custom rules with default rules
 */
export function mergeRules(customRules: RoutingRule[]): RoutingRule[] {
  // Custom rules override defaults with the same name
  const customNames = new Set(customRules.map(r => r.name));
  const filteredDefaults = DEFAULT_ROUTING_RULES.filter(
    r => !customNames.has(r.name)
  );
  return [...customRules, ...filteredDefaults];
}
