/**
 * Agent Utilities
 *
 * Shared utilities for agent creation and management.
 * Includes prompt builders and configuration helpers.
 *
 * Ported from oh-my-opencode's agent utils.
 */
import type { AgentConfig, AgentPromptMetadata, AvailableAgent, AgentOverrideConfig } from './types.js';
/**
 * Load an agent prompt from /agents/{agentName}.md
 * Uses build-time embedded prompts when available (CJS bundles),
 * falls back to runtime file reads (dev/test environments).
 *
 * Security: Validates agent name to prevent path traversal attacks
 */
export declare function loadAgentPrompt(agentName: string): string;
/**
 * Create tool restrictions configuration
 * Returns an object that can be spread into agent config to restrict tools
 */
export declare function createAgentToolRestrictions(blockedTools: string[]): {
    tools: Record<string, boolean>;
};
/**
 * Merge agent configuration with overrides
 */
export declare function mergeAgentConfig(base: AgentConfig, override: AgentOverrideConfig): AgentConfig;
/**
 * Build delegation table section for OMC prompt
 */
export declare function buildDelegationTable(availableAgents: AvailableAgent[]): string;
/**
 * Build use/avoid section for an agent
 */
export declare function buildUseAvoidSection(metadata: AgentPromptMetadata): string;
/**
 * Create environment context for agents
 */
export declare function createEnvContext(): string;
/**
 * Get all available agents as AvailableAgent descriptors
 */
export declare function getAvailableAgents(agents: Record<string, AgentConfig>): AvailableAgent[];
/**
 * Build key triggers section for OMC prompt
 */
export declare function buildKeyTriggersSection(availableAgents: AvailableAgent[]): string;
/**
 * Validate agent configuration
 */
export declare function validateAgentConfig(config: AgentConfig): string[];
/**
 * Parse disallowedTools from agent markdown frontmatter
 */
export declare function parseDisallowedTools(agentName: string): string[] | undefined;
/**
 * Standard path for open questions file
 */
export declare const OPEN_QUESTIONS_PATH = ".omc/plans/open-questions.md";
/**
 * Format open questions for appending to the standard open-questions.md file.
 *
 * @param topic - The plan or analysis topic name
 * @param questions - Array of { question, reason } objects
 * @returns Formatted markdown string ready to append
 */
export declare function formatOpenQuestions(topic: string, questions: Array<{
    question: string;
    reason: string;
}>): string;
/**
 * Deep merge utility for configurations
 */
export declare function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T;
//# sourceMappingURL=utils.d.ts.map