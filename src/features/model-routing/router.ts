/**
 * Model Router
 *
 * Main routing engine that determines which model tier to use for a given task.
 * Combines signal extraction, scoring, and rules evaluation.
 */

import type {
  RoutingContext,
  RoutingDecision,
  RoutingConfig,
  ComplexityTier,
} from './types.js';
import {
  DEFAULT_ROUTING_CONFIG,
  TIER_TO_MODEL_TYPE,
} from './types.js';
import { extractAllSignals } from './signals.js';
import { calculateComplexityScore, calculateConfidence, scoreToTier } from './scorer.js';
import { evaluateRules, DEFAULT_ROUTING_RULES } from './rules.js';

/**
 * Route a task to the appropriate model tier
 */
export function routeTask(
  context: RoutingContext,
  config: Partial<RoutingConfig> = {}
): RoutingDecision {
  const mergedConfig = { ...DEFAULT_ROUTING_CONFIG, ...config };

  // If routing is disabled, use default tier
  if (!mergedConfig.enabled) {
    return createDecision(mergedConfig.defaultTier, mergedConfig.tierModels, ['Routing disabled, using default tier'], false);
  }

  // If explicit model is specified, respect it
  if (context.explicitModel) {
    const explicitTier = modelTypeToTier(context.explicitModel);
    return createDecision(explicitTier, mergedConfig.tierModels, ['Explicit model specified by user'], false, explicitTier);
  }

  // Check for agent-specific overrides
  if (context.agentType && mergedConfig.agentOverrides?.[context.agentType]) {
    const override = mergedConfig.agentOverrides[context.agentType];
    return createDecision(override.tier, mergedConfig.tierModels, [override.reason], false, override.tier);
  }

  // Extract signals from the task
  const signals = extractAllSignals(context.taskPrompt, context);

  // Evaluate routing rules
  const ruleResult = evaluateRules(context, signals, DEFAULT_ROUTING_RULES);

  if (ruleResult.tier === 'EXPLICIT') {
    // Explicit model was handled above, this shouldn't happen
    return createDecision('MEDIUM', mergedConfig.tierModels, ['Unexpected EXPLICIT tier'], false);
  }

  // Calculate score for confidence and logging
  const score = calculateComplexityScore(signals);
  const scoreTier = scoreToTier(score);
  let confidence = calculateConfidence(score, ruleResult.tier);

  let finalTier = ruleResult.tier;
  const tierOrder: ComplexityTier[] = ['LOW', 'MEDIUM', 'HIGH'];
  const ruleIdx = tierOrder.indexOf(ruleResult.tier);
  const scoreIdx = tierOrder.indexOf(scoreTier);

  // When scorer and rules diverge by more than 1 level, reduce confidence
  // and prefer the higher tier to avoid under-provisioning
  const divergence = Math.abs(ruleIdx - scoreIdx);
  if (divergence > 1) {
    confidence = Math.min(confidence, 0.5);
    finalTier = tierOrder[Math.max(ruleIdx, scoreIdx)];
  }

  const reasons = [
    ruleResult.reason,
    `Rule: ${ruleResult.ruleName}`,
    `Score: ${score} (${scoreTier} tier by score)`,
    ...(divergence > 1 ? [`Scorer/rules divergence (${divergence} levels): confidence reduced, preferred higher tier`] : []),
  ];

  // Enforce minTier if configured
  if (mergedConfig.minTier) {
    const currentIdx = tierOrder.indexOf(finalTier);
    const minIdx = tierOrder.indexOf(mergedConfig.minTier);
    if (currentIdx < minIdx) {
      finalTier = mergedConfig.minTier;
      reasons.push(`Min tier enforced: ${ruleResult.tier} -> ${finalTier}`);
    }
  }

  return {
    model: mergedConfig.tierModels[finalTier],
    modelType: TIER_TO_MODEL_TYPE[finalTier],
    tier: finalTier,
    confidence,
    reasons,
    escalated: false,
  };
}

/**
 * Create a routing decision for a given tier
 */
function createDecision(
  tier: ComplexityTier,
  tierModels: Record<ComplexityTier, string>,
  reasons: string[],
  escalated: boolean,
  originalTier?: ComplexityTier
): RoutingDecision {
  return {
    model: tierModels[tier],
    modelType: TIER_TO_MODEL_TYPE[tier],
    tier,
    confidence: escalated ? 0.9 : 0.7, // Higher confidence after escalation
    reasons,
    escalated,
    originalTier,
  };
}

/**
 * Convert ModelType to ComplexityTier
 */
function modelTypeToTier(modelType: string): ComplexityTier {
  switch (modelType) {
    case 'opus':
      return 'HIGH';
    case 'haiku':
      return 'LOW';
    case 'sonnet':
    default:
      return 'MEDIUM';
  }
}

/**
 * Escalate to a higher tier after failure
 */
export function escalateModel(currentTier: ComplexityTier): ComplexityTier {
  switch (currentTier) {
    case 'LOW':
      return 'MEDIUM';
    case 'MEDIUM':
      return 'HIGH';
    case 'HIGH':
      return 'HIGH'; // Already at max
  }
}

/**
 * Check if we can escalate further
 */
export function canEscalate(currentTier: ComplexityTier): boolean {
  return currentTier !== 'HIGH';
}

/**
 * Get routing recommendation for orchestrator
 *
 * This is designed for PROACTIVE routing - the orchestrator (Opus) analyzes
 * task complexity BEFORE delegation and chooses the appropriate model tier.
 *
 * NOT reactive escalation - the right model is chosen upfront.
 */
export function getRoutingRecommendation(
  context: RoutingContext,
  config: Partial<RoutingConfig> = {}
): RoutingDecision {
  return routeTask(context, config);
}

/**
 * Legacy: Route with escalation support
 * @deprecated Use getRoutingRecommendation for proactive routing instead.
 * The orchestrator should analyze complexity upfront, not escalate reactively.
 */
export function routeWithEscalation(
  context: RoutingContext,
  config: Partial<RoutingConfig> = {}
): RoutingDecision {
  // Simply return the routing recommendation
  // Reactive escalation is deprecated - orchestrator decides upfront
  return routeTask(context, config);
}

/**
 * Get routing explanation for debugging/logging
 */
export function explainRouting(
  context: RoutingContext,
  config: Partial<RoutingConfig> = {}
): string {
  const decision = routeTask(context, config);
  const signals = extractAllSignals(context.taskPrompt, context);

  const lines = [
    '=== Model Routing Decision ===',
    `Task: ${context.taskPrompt.substring(0, 100)}${context.taskPrompt.length > 100 ? '...' : ''}`,
    `Agent: ${context.agentType ?? 'unspecified'}`,
    '',
    '--- Signals ---',
    `Word count: ${signals.lexical.wordCount}`,
    `File paths: ${signals.lexical.filePathCount}`,
    `Architecture keywords: ${signals.lexical.hasArchitectureKeywords}`,
    `Debugging keywords: ${signals.lexical.hasDebuggingKeywords}`,
    `Simple keywords: ${signals.lexical.hasSimpleKeywords}`,
    `Risk keywords: ${signals.lexical.hasRiskKeywords}`,
    `Question depth: ${signals.lexical.questionDepth}`,
    `Estimated subtasks: ${signals.structural.estimatedSubtasks}`,
    `Cross-file: ${signals.structural.crossFileDependencies}`,
    `Impact scope: ${signals.structural.impactScope}`,
    `Reversibility: ${signals.structural.reversibility}`,
    `Previous failures: ${signals.context.previousFailures}`,
    '',
    '--- Decision ---',
    `Tier: ${decision.tier}`,
    `Model: ${decision.model}`,
    `Confidence: ${decision.confidence}`,
    `Escalated: ${decision.escalated}`,
    '',
    '--- Reasons ---',
    ...decision.reasons.map(r => `  - ${r}`),
  ];

  return lines.join('\n');
}

/**
 * Quick tier lookup for known agent types
 * Useful for cases where we don't need full signal analysis
 */
export function quickTierForAgent(agentType: string): ComplexityTier | null {
  const agentTiers: Record<string, ComplexityTier> = {
    architect: 'HIGH',
    planner: 'HIGH',
    critic: 'HIGH',
    analyst: 'HIGH',
    explore: 'LOW',
    'writer': 'LOW',
    'document-specialist': 'MEDIUM',
    researcher: 'MEDIUM',
    'test-engineer': 'MEDIUM',
    'tdd-guide': 'MEDIUM',
    'executor': 'MEDIUM',
    'designer': 'MEDIUM',
    'vision': 'MEDIUM',
  };

  return agentTiers[agentType] ?? null;
}


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
export function getModelForTask(
  agentType: string,
  taskPrompt: string,
  config: Partial<RoutingConfig> = {}
): { model: 'haiku' | 'sonnet' | 'opus'; tier: ComplexityTier; reason: string } {
  // All agents are adaptive based on task complexity
  // Use agent-specific rules for advisory agents, general rules for others
  const decision = routeTask({ taskPrompt, agentType }, config);

  return {
    model: decision.modelType as 'haiku' | 'sonnet' | 'opus',
    tier: decision.tier,
    reason: decision.reasons[0] ?? 'Complexity analysis',
  };
}


/**
 * Generate a complexity analysis summary for the orchestrator
 *
 * Returns a human-readable analysis explaining the routing recommendation.
 */
export function analyzeTaskComplexity(
  taskPrompt: string,
  agentType?: string
): {
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
} {
  const signals = extractAllSignals(taskPrompt, { taskPrompt, agentType });
  const decision = routeTask({ taskPrompt, agentType });

  const analysis = [
    `**Tier: ${decision.tier}** → ${decision.model}`,
    '',
    '**Why:**',
    ...decision.reasons.map(r => `- ${r}`),
    '',
    '**Signals detected:**',
    signals.lexical.hasArchitectureKeywords ? '- Architecture keywords (refactor, redesign, etc.)' : null,
    signals.lexical.hasRiskKeywords ? '- Risk keywords (migration, production, critical)' : null,
    signals.lexical.hasDebuggingKeywords ? '- Debugging keywords (root cause, investigate)' : null,
    signals.structural.crossFileDependencies ? '- Cross-file dependencies' : null,
    signals.structural.impactScope === 'system-wide' ? '- System-wide impact' : null,
    signals.structural.reversibility === 'difficult' ? '- Difficult to reverse' : null,
  ].filter(Boolean).join('\n');

  return {
    tier: decision.tier,
    model: decision.model,
    analysis,
    signals: {
      wordCount: signals.lexical.wordCount,
      hasArchitectureKeywords: signals.lexical.hasArchitectureKeywords,
      hasRiskKeywords: signals.lexical.hasRiskKeywords,
      estimatedSubtasks: signals.structural.estimatedSubtasks,
      impactScope: signals.structural.impactScope,
    },
  };
}
