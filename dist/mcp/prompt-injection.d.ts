/**
 * Prompt Injection Helper
 *
 * Shared utilities for injecting system prompts into Codex/Gemini MCP tools.
 * Enables agents to pass their personality/guidelines when consulting external models.
 */
/**
 * Check if a role name is valid (contains only allowed characters).
 * This is a security check, not an allowlist check.
 */
export declare function isValidAgentRoleName(name: string): boolean;
export declare function getValidAgentRoles(): string[];
/**
 * Valid agent roles discovered dynamically from agents/*.md files.
 * This is computed at module load time for backward compatibility.
 */
export declare const VALID_AGENT_ROLES: readonly string[];
/**
 * AgentRole type - now string since roles are dynamic.
 */
export type AgentRole = string;
/**
 * Resolve the system prompt from either explicit system_prompt or agent_role.
 * system_prompt takes precedence over agent_role.
 *
 * Returns undefined if neither is provided or resolution fails.
 */
export declare function resolveSystemPrompt(systemPrompt?: string, agentRole?: string): string | undefined;
/**
 * Wrap file content with untrusted delimiters to prevent prompt injection.
 * Each file's content is clearly marked as data to analyze, not instructions.
 */
export declare function wrapUntrustedFileContent(filepath: string, content: string): string;
/**
 * Build the full prompt with system prompt prepended.
 *
 * Order: system_prompt > file_context > user_prompt
 *
 * Uses clear XML-like delimiters so the external model can distinguish sections.
 * File context is wrapped with untrusted data warnings to mitigate prompt injection.
 */
export declare function buildPromptWithSystemContext(userPrompt: string, fileContext: string | undefined, systemPrompt: string | undefined): string;
//# sourceMappingURL=prompt-injection.d.ts.map