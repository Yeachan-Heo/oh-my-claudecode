export { resolveSystemPrompt, getValidAgentRoles, isValidAgentRoleName, VALID_AGENT_ROLES, wrapUntrustedFileContent, wrapUntrustedCliResponse, sanitizePromptContent, singleErrorBlock, inlineSuccessBlocks, } from '../agents/prompt-helpers.js';
export type { AgentRole } from '../agents/prompt-helpers.js';
/**
 * Subagent mode marker prepended to all prompts sent to external CLI agents.
 * Prevents recursive subagent spawning within subagent tool calls.
 */
export declare const SUBAGENT_HEADER = "[SUBAGENT MODE] You are a subagent running inside a tool call.\nDO NOT spawn additional subagents or invoke Codex/Gemini CLI recursively.\nComplete the task directly with your available tools.";
/**
 * Validate context file paths for use as external model context.
 * Rejects paths with control characters (prompt injection) and paths that
 * escape the base directory (path traversal).
 */
export declare function validateContextFilePaths(paths: string[], baseDir: string, allowExternal?: boolean): {
    validPaths: string[];
    errors: string[];
};
/**
 * Build the full prompt for an external CLI agent.
 * Always prepends SUBAGENT_HEADER to prevent recursive agent spawning.
 * Order: SUBAGENT_HEADER > system_prompt > file_context > user_prompt
 */
export declare function buildPromptWithSystemContext(userPrompt: string, fileContext: string | undefined, systemPrompt: string | undefined): string;
//# sourceMappingURL=prompt-injection.d.ts.map