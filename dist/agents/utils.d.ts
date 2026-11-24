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
 * Strip YAML frontmatter from markdown content.
 */
export declare function stripFrontmatter(content: string): string;
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
 * Read the comma-separated disallowedTools list from agent frontmatter.
 */
export declare function extractDisallowedTools(content: string): string[] | undefined;
/**
 * Environment variable that adds tools to every agent's disallowedTools list.
 * Comma-separated tool names or patterns; unset or empty changes nothing.
 */
export declare const EXTRA_DISALLOWED_TOOLS_ENV = "OMC_AGENT_EXTRA_DISALLOWED_TOOLS";
/**
 * Tool names and patterns the `desktop` preset expands to: the desktop app's
 * artifact tools and its turn, session, visualize and browser tool families.
 */
export declare const DESKTOP_APP_DISALLOWED_TOOLS: readonly string[];
/**
 * Read the extra disallowed tools from OMC_AGENT_EXTRA_DISALLOWED_TOOLS.
 * Tokens are trimmed, empty tokens and tokens containing a line break are
 * ignored, `desktop` (any case) expands to DESKTOP_APP_DISALLOWED_TOOLS, and
 * duplicates are removed keeping the first occurrence.
 */
export declare function getExtraDisallowedTools(env?: NodeJS.ProcessEnv): string[];
/**
 * Append extra tools to an agent's own disallowedTools list. Entries of the
 * agent's list are never removed or reordered. With no extra tools the
 * original value is returned unchanged (including `undefined`).
 */
export declare function mergeDisallowedTools(base: string[] | undefined, extra: readonly string[]): string[] | undefined;
/**
 * Whether a token can be written into a frontmatter line as a plain YAML
 * text value. Rejected: line breaks (including U+0085, U+2028 and U+2029), a
 * colon followed by whitespace or ending the token, a `#` preceded by
 * whitespace, a leading character that YAML gives a meaning (`-`, `?`, `:`,
 * `#`, `&`, `*`, `!`, `|`, `>`, quotes, `%`, `@`, a backtick, `[`, `{`, `]`, `}`), and
 * words YAML reads as null, boolean or number instead of text. A `*` inside
 * a pattern such as `mcp__server__*` is accepted.
 */
export declare function isPlainYamlToken(token: string): boolean;
/**
 * Apply extra disallowed tools to agent markdown: append them to the
 * `disallowedTools:` frontmatter line, or add that line when the agent has
 * none. Tokens that are not plain YAML text (see isPlainYamlToken) are
 * skipped. Returns the content unchanged when no usable extra tool remains,
 * there is no frontmatter, or the existing `disallowedTools:` entry is
 * written in a form this does not rewrite (empty value, block list, flow
 * list, trailing comment).
 */
export declare function applyExtraDisallowedToolsToMarkdown(content: string, extra: readonly string[]): string;
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