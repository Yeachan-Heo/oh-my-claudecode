/**
 * Prompt Injection Helper
 *
 * Shared utilities for injecting system prompts into Codex/Gemini MCP tools.
 * Enables agents to pass their personality/guidelines when consulting external models.
 */

import { loadAgentPrompt } from '../agents/utils.js';

/**
 * Valid agent roles that can be used with agent_role parameter.
 * Matches the agent prompt files in agents/*.md
 */
export const VALID_AGENT_ROLES = [
  'architect', 'architect-medium', 'architect-low',
  'analyst', 'critic', 'planner',
  'executor', 'executor-high', 'executor-low',
  'deep-executor',
  'designer', 'designer-low', 'designer-high',
  'explore', 'explore-high',
  'researcher',
  'writer', 'vision',
  'qa-tester',
  'scientist', 'scientist-high',
  'security-reviewer', 'security-reviewer-low',
  'build-fixer',
  'tdd-guide', 'tdd-guide-low',
  'code-reviewer',
  'git-master',
] as const;

export type AgentRole = typeof VALID_AGENT_ROLES[number];

/**
 * Resolve the system prompt from either explicit system_prompt or agent_role.
 * system_prompt takes precedence over agent_role.
 *
 * Returns undefined if neither is provided or resolution fails.
 */
export function resolveSystemPrompt(
  systemPrompt?: string,
  agentRole?: string
): string | undefined {
  // Explicit system_prompt takes precedence
  if (systemPrompt && systemPrompt.trim()) {
    return systemPrompt.trim();
  }

  // Fall back to agent_role lookup
  if (agentRole && agentRole.trim()) {
    const role = agentRole.trim();
    // loadAgentPrompt already validates the name and handles errors gracefully
    const prompt = loadAgentPrompt(role);
    // loadAgentPrompt returns "Agent: {name}\n\nPrompt unavailable." on failure
    if (prompt.includes('Prompt unavailable')) {
      console.warn(`[prompt-injection] Agent role "${role}" prompt not found, skipping injection`);
      return undefined;
    }
    return prompt;
  }

  return undefined;
}

/**
 * Build the full prompt with system prompt prepended.
 *
 * Order: system_prompt > file_context > user_prompt
 *
 * Uses clear XML-like delimiters so the external model can distinguish sections.
 */
export function buildPromptWithSystemContext(
  userPrompt: string,
  fileContext: string | undefined,
  systemPrompt: string | undefined
): string {
  const parts: string[] = [];

  if (systemPrompt) {
    parts.push(`<system-instructions>\n${systemPrompt}\n</system-instructions>`);
  }

  if (fileContext) {
    parts.push(fileContext);
  }

  parts.push(userPrompt);

  return parts.join('\n\n');
}
