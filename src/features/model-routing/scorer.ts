/**
 * Complexity Scorer
 *
 * Calculates complexity tier based on extracted signals.
 * Uses weighted scoring to determine LOW/MEDIUM/HIGH tier.
 */

import type {
  ComplexitySignals,
  ComplexityTier,
  LexicalSignals,
  StructuralSignals,
  ContextSignals,
} from './types.js';

/**
 * Score thresholds for tier classification
 */
const TIER_THRESHOLDS = {
  HIGH: 8,    // Score >= 8 -> HIGH (Opus)
  MEDIUM: 4,  // Score >= 4 -> MEDIUM (Sonnet)
  // Score < 4 -> LOW (Haiku)
};

/**
 * Weight configuration for different signal categories
 * Total should roughly sum to enable score range 0-15+
 */
const WEIGHTS = {
  lexical: {
    wordCountHigh: 2,         // Long prompts (+2)
    wordCountVeryHigh: 1,     // Very long prompts (+1 additional)
    filePathsMultiple: 1,     // Multiple file paths (+1)
    codeBlocksPresent: 1,     // Code blocks (+1)
    architectureKeywords: 3,  // Architecture keywords (+3)
    debuggingKeywords: 2,     // Debugging keywords (+2)
    simpleKeywords: -2,       // Simple keywords (-2)
    riskKeywords: 2,          // Risk keywords (+2)
    questionDepthWhy: 2,      // 'Why' questions (+2)
    questionDepthHow: 1,      // 'How' questions (+1)
    implicitRequirements: 1,  // Vague requirements (+1)
  },
  structural: {
    subtasksMany: 3,          // Many subtasks (+3)
    subtasksSome: 1,          // Some subtasks (+1)
    crossFile: 2,             // Cross-file changes (+2)
    testRequired: 1,          // Tests required (+1)
    securityDomain: 2,        // Security domain (+2)
    infrastructureDomain: 1,  // Infrastructure domain (+1)
    externalKnowledge: 1,     // External knowledge needed (+1)
    reversibilityDifficult: 2, // Difficult to reverse (+2)
    reversibilityModerate: 1,  // Moderate reversibility (+1)
    impactSystemWide: 3,      // System-wide impact (+3)
    impactModule: 1,          // Module-level impact (+1)
  },
  context: {
    previousFailure: 2,       // Per previous failure (+2 each)
    previousFailureMax: 4,    // Max from failures
    deepChain: 2,             // Deep agent chain (+2)
    complexPlan: 1,           // Complex plan (+1)
  },
};

/**
 * Calculate complexity score from lexical signals
 */
function scoreLexicalSignals(signals: LexicalSignals): number {
  let score = 0;

  // Word count scoring
  if (signals.wordCount > 200) {
    score += WEIGHTS.lexical.wordCountHigh;
    if (signals.wordCount > 500) {
      score += WEIGHTS.lexical.wordCountVeryHigh;
    }
  }

  // File paths
  if (signals.filePathCount >= 2) {
    score += WEIGHTS.lexical.filePathsMultiple;
  }

  // Code blocks
  if (signals.codeBlockCount > 0) {
    score += WEIGHTS.lexical.codeBlocksPresent;
  }

  // Keyword scoring
  if (signals.hasArchitectureKeywords) {
    score += WEIGHTS.lexical.architectureKeywords;
  }
  if (signals.hasDebuggingKeywords) {
    score += WEIGHTS.lexical.debuggingKeywords;
  }
  if (signals.hasSimpleKeywords) {
    score += WEIGHTS.lexical.simpleKeywords; // Negative weight
  }
  if (signals.hasRiskKeywords) {
    score += WEIGHTS.lexical.riskKeywords;
  }

  // Question depth
  switch (signals.questionDepth) {
    case 'why':
      score += WEIGHTS.lexical.questionDepthWhy;
      break;
    case 'how':
      score += WEIGHTS.lexical.questionDepthHow;
      break;
    // 'what', 'where', 'none' add nothing
  }

  // Implicit requirements
  if (signals.hasImplicitRequirements) {
    score += WEIGHTS.lexical.implicitRequirements;
  }

  return score;
}

/**
 * Calculate complexity score from structural signals
 */
function scoreStructuralSignals(signals: StructuralSignals): number {
  let score = 0;

  // Subtask scoring
  if (signals.estimatedSubtasks > 3) {
    score += WEIGHTS.structural.subtasksMany;
  } else if (signals.estimatedSubtasks > 1) {
    score += WEIGHTS.structural.subtasksSome;
  }

  // Cross-file dependencies
  if (signals.crossFileDependencies) {
    score += WEIGHTS.structural.crossFile;
  }

  // Test requirements
  if (signals.hasTestRequirements) {
    score += WEIGHTS.structural.testRequired;
  }

  // Domain specificity
  switch (signals.domainSpecificity) {
    case 'security':
      score += WEIGHTS.structural.securityDomain;
      break;
    case 'infrastructure':
      score += WEIGHTS.structural.infrastructureDomain;
      break;
    // Other domains add nothing
  }

  // External knowledge
  if (signals.requiresExternalKnowledge) {
    score += WEIGHTS.structural.externalKnowledge;
  }

  // Reversibility
  switch (signals.reversibility) {
    case 'difficult':
      score += WEIGHTS.structural.reversibilityDifficult;
      break;
    case 'moderate':
      score += WEIGHTS.structural.reversibilityModerate;
      break;
  }

  // Impact scope
  switch (signals.impactScope) {
    case 'system-wide':
      score += WEIGHTS.structural.impactSystemWide;
      break;
    case 'module':
      score += WEIGHTS.structural.impactModule;
      break;
  }

  return score;
}

/**
 * Calculate complexity score from context signals
 */
function scoreContextSignals(signals: ContextSignals): number {
  let score = 0;

  // Previous failures (capped)
  const failureScore = Math.min(
    signals.previousFailures * WEIGHTS.context.previousFailure,
    WEIGHTS.context.previousFailureMax
  );
  score += failureScore;

  // Deep agent chain (3+ levels)
  if (signals.agentChainDepth >= 3) {
    score += WEIGHTS.context.deepChain;
  }

  // Complex plan (5+ tasks)
  if (signals.planComplexity >= 5) {
    score += WEIGHTS.context.complexPlan;
  }

  return score;
}

/**
 * Calculate total complexity score
 */
export function calculateComplexityScore(signals: ComplexitySignals): number {
  const lexicalScore = scoreLexicalSignals(signals.lexical);
  const structuralScore = scoreStructuralSignals(signals.structural);
  const contextScore = scoreContextSignals(signals.context);

  return lexicalScore + structuralScore + contextScore;
}

/**
 * Determine complexity tier from score
 */
export function scoreToTier(score: number): ComplexityTier {
  if (score >= TIER_THRESHOLDS.HIGH) return 'HIGH';
  if (score >= TIER_THRESHOLDS.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/**
 * Calculate complexity tier from signals
 */
export function calculateComplexityTier(signals: ComplexitySignals): ComplexityTier {
  const score = calculateComplexityScore(signals);
  return scoreToTier(score);
}

/**
 * Get detailed score breakdown for debugging/logging
 */
export function getScoreBreakdown(signals: ComplexitySignals): {
  lexical: number;
  structural: number;
  context: number;
  total: number;
  tier: ComplexityTier;
} {
  const lexical = scoreLexicalSignals(signals.lexical);
  const structural = scoreStructuralSignals(signals.structural);
  const context = scoreContextSignals(signals.context);
  const total = lexical + structural + context;

  return {
    lexical,
    structural,
    context,
    total,
    tier: scoreToTier(total),
  };
}

/**
 * Calculate confidence in the tier assignment
 * Higher confidence when score is far from thresholds
 */
export function calculateConfidence(score: number, tier: ComplexityTier): number {
  const distanceFromLow = Math.abs(score - TIER_THRESHOLDS.MEDIUM);
  const distanceFromHigh = Math.abs(score - TIER_THRESHOLDS.HIGH);

  // Minimum distance from any threshold
  let minDistance: number;
  switch (tier) {
    case 'LOW':
      minDistance = TIER_THRESHOLDS.MEDIUM - score;
      break;
    case 'MEDIUM':
      minDistance = Math.min(distanceFromLow, distanceFromHigh);
      break;
    case 'HIGH':
      minDistance = score - TIER_THRESHOLDS.HIGH;
      break;
  }

  // Convert distance to confidence (0-1)
  // Distance of 0 = 0.5 confidence, distance of 4+ = 0.9+ confidence
  const confidence = 0.5 + (Math.min(minDistance, 4) / 4) * 0.4;
  return Math.round(confidence * 100) / 100;
}
