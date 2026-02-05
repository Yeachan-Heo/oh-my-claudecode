/**
 * Agent v4 Types
 *
 * Core type definitions for the refactored agent system.
 */

import type { ModelType } from "../shared/types.js";

/**
 * Canonical agent roles.
 */
export type AgentRole =
  | "architect"
  | "researcher"
  | "explore"
  | "designer"
  | "writer"
  | "vision"
  | "critic"
  | "analyst"
  | "executor"
  | "planner"
  | "qa-tester"
  | "scientist";

/**
 * Complexity tiers for routing and composition.
 */
export type ComplexityTier = "LOW" | "MEDIUM" | "HIGH";

/**
 * A single prompt section (composable building block).
 */
export interface PromptSection {
  /** Unique identifier for this section */
  id: string;
  /** Display name */
  name: string;
  /** The actual prompt content (markdown) */
  content: string;
  /** Order in composition (lower = earlier) */
  order: number;
}

/**
 * Tier overlay - behavioral modifications per tier.
 */
export interface TierOverlay {
  tier: ComplexityTier;
  model: ModelType;
  /** Tier-specific instructions injected into prompt */
  instructions: string;
  /** Max files the agent should explore */
  maxFileExploration: number;
  /** Whether this tier can escalate */
  canEscalate: boolean;
  /** Tool additions/removals for this tier */
  toolModifiers?: {
    add?: string[];
    remove?: string[];
  };
}

/**
 * Role definition - what makes each agent unique.
 */
export interface AgentRoleDefinition {
  role: AgentRole;
  /** Short description for agent selection */
  description: string;
  /** Default model tier */
  defaultTier: ComplexityTier;
  /** Base tools (before tier modifiers) */
  baseTools: string[];
  /** Category for grouping */
  category:
    | "exploration"
    | "specialist"
    | "advisor"
    | "utility"
    | "planner"
    | "reviewer";
  /** Role-specific prompt content */
  rolePrompt: string;
  /** Whether this is a read-only agent (no Write/Edit/Bash) */
  readOnly: boolean;
  /** Additional prompt sections this role needs */
  additionalSections?: string[];
}

/**
 * Composed agent config (output of the composer).
 */
export interface ComposedAgentConfig {
  /** Legacy-compatible name (e.g., 'architect-low') */
  name: string;
  /** Role */
  role: AgentRole;
  /** Tier */
  tier: ComplexityTier;
  /** Final composed prompt */
  prompt: string;
  /** Final tool list (base + tier modifiers) */
  tools: string[];
  /** Model type */
  model: ModelType;
  /** Short description */
  description: string;
}

/**
 * Legacy alias mapping old names to new role+tier.
 */
export interface LegacyAlias {
  role: AgentRole;
  tier: ComplexityTier;
}
