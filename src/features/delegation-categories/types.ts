/**
 * Delegation Categories Types
 *
 * Category-based delegation system that layers on top of ComplexityTier.
 * Categories provide semantic grouping with tier, temperature, and thinking budget.
 */

import type { ComplexityTier } from '../model-routing/types.js';

/**
 * Semantic categories for delegation that map to complexity tiers + configuration
 */
export type DelegationCategory =
  | 'visual-engineering'
  | 'ultrabrain'
  | 'artistry'
  | 'quick'
  | 'writing'
  | 'unspecified-low'
  | 'unspecified-high';

/**
 * Thinking budget levels
 */
export type ThinkingBudget = 'low' | 'medium' | 'high' | 'max';

/**
 * Configuration for a delegation category
 */
export interface CategoryConfig {
  /** Complexity tier (LOW/MEDIUM/HIGH) */
  tier: ComplexityTier;
  /** Temperature for model sampling (0-1) */
  temperature: number;
  /** Thinking budget level */
  thinkingBudget: ThinkingBudget;
  /** Optional prompt appendix for this category */
  promptAppend?: string;
  /** Human-readable description */
  description: string;
}

/**
 * Resolved category with full configuration
 */
export interface ResolvedCategory extends CategoryConfig {
  /** The category identifier */
  category: DelegationCategory;
}

/**
 * Context for category resolution
 */
export interface CategoryContext {
  /** Task description */
  taskPrompt: string;
  /** Agent type being delegated to */
  agentType?: string;
  /** Explicitly specified category (overrides detection) */
  explicitCategory?: DelegationCategory;
  /** Explicitly specified tier (bypasses categories) */
  explicitTier?: ComplexityTier;
}
