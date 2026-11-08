/**
 * Complexity Scorer
 *
 * Calculates complexity tier based on extracted signals.
 * Uses weighted scoring to determine LOW/MEDIUM/HIGH tier.
 */
import type { ComplexitySignals, ComplexityTier } from './types.js';
/**
 * Calculate total complexity score
 */
export declare function calculateComplexityScore(signals: ComplexitySignals): number;
/**
 * Determine complexity tier from score
 */
export declare function scoreToTier(score: number): ComplexityTier;
/**
 * Calculate complexity tier from signals
 */
export declare function calculateComplexityTier(signals: ComplexitySignals): ComplexityTier;
/**
 * Get detailed score breakdown for debugging/logging
 */
export declare function getScoreBreakdown(signals: ComplexitySignals): {
    lexical: number;
    structural: number;
    context: number;
    total: number;
    tier: ComplexityTier;
};
/**
 * Calculate confidence in the tier assignment
 * Higher confidence when score is far from thresholds
 */
export declare function calculateConfidence(score: number, tier: ComplexityTier): number;
//# sourceMappingURL=scorer.d.ts.map