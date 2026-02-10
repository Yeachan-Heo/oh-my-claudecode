/**
 * Agent Types for Oh-My-Claude-Sisyphus
 *
 * Defines types for agent configuration and metadata used in dynamic prompt generation.
 * Ported from oh-my-opencode's agent type system.
 */
import type { ModelType } from '../shared/types.js';
export type { ModelType };
/**
 * Cost tier for agent usage
 * Used to guide when to invoke expensive vs cheap agents
 */
export type AgentCost = 'FREE' | 'CHEAP' | 'EXPENSIVE';
/**
 * Agent category for routing and grouping
 */
export type AgentCategory = 'exploration' | 'specialist' | 'advisor' | 'utility' | 'orchestration' | 'planner' | 'reviewer';
/**
 * Trigger condition for delegation
 */
export interface DelegationTrigger {
    /** Domain or area this trigger applies to */
    domain: string;
    /** Condition that triggers delegation */
    trigger: string;
}
/**
 * Metadata about an agent for dynamic prompt generation
 * This enables Sisyphus to build delegation tables automatically
 */
export interface AgentPromptMetadata {
    /** Agent category */
    category: AgentCategory;
    /** Cost tier */
    cost: AgentCost;
    /** Short alias for prompts */
    promptAlias?: string;
    /** Conditions that trigger delegation to this agent */
    triggers: DelegationTrigger[];
    /** When to use this agent */
    useWhen?: string[];
    /** When NOT to use this agent */
    avoidWhen?: string[];
    /** Description for dynamic prompt building */
    promptDescription?: string;
    /** Tools this agent uses (for tool selection guidance) */
    tools?: string[];
}
/**
 * Base agent configuration
 */
export interface AgentConfig {
    /** Agent name/identifier */
    name: string;
    /** Short description for agent selection */
    description: string;
    /** System prompt for the agent */
    prompt: string;
    /** Tools the agent can use (optional - all tools allowed by default if omitted) */
    tools?: string[];
    /** Tools explicitly disallowed for this agent */
    disallowedTools?: string[];
    /** Model to use (defaults to sonnet) */
    model?: ModelType;
    /** Default model for this agent (explicit tier mapping) */
    defaultModel?: ModelType;
    /** Optional metadata for dynamic prompt generation */
    metadata?: AgentPromptMetadata;
}
/**
 * Extended agent config with all optional fields
 */
export interface FullAgentConfig extends AgentConfig {
    /** Temperature setting */
    temperature?: number;
    /** Max tokens */
    maxTokens?: number;
    /** Thinking configuration (for Claude models) */
    thinking?: {
        type: 'enabled' | 'disabled';
        budgetTokens?: number;
    };
    /** Tool restrictions */
    toolRestrictions?: string[];
}
/**
 * Agent override configuration for customization
 */
export interface AgentOverrideConfig {
    /** Override model */
    model?: string;
    /** Enable/disable agent */
    enabled?: boolean;
    /** Append to prompt */
    prompt_append?: string;
    /** Override temperature */
    temperature?: number;
}
/**
 * Map of agent overrides
 */
export type AgentOverrides = Partial<Record<string, AgentOverrideConfig>>;
/**
 * Factory function signature for creating agents
 */
export type AgentFactory = (model?: string) => AgentConfig;
/**
 * Available agent descriptor for Sisyphus prompt building
 */
export interface AvailableAgent {
    name: string;
    description: string;
    metadata: AgentPromptMetadata;
}
/**
 * Check if a model ID is a GPT model
 */
export declare function isGptModel(modelId: string): boolean;
/**
 * Check if a model ID is a Claude model
 */
export declare function isClaudeModel(modelId: string): boolean;
/**
 * Get default model for a category
 */
export declare function getDefaultModelForCategory(category: AgentCategory): ModelType;
//# sourceMappingURL=types.d.ts.map