// src/mcp/prompt-injection.ts
// Re-export shared prompt utilities from agents/prompt-helpers
export {
  resolveSystemPrompt,
  getValidAgentRoles,
  isValidAgentRoleName,
  VALID_AGENT_ROLES,
  wrapUntrustedFileContent,
  wrapUntrustedCliResponse,
  sanitizePromptContent,
  singleErrorBlock,
  inlineSuccessBlocks,
} from '../agents/prompt-helpers.js';
export type { AgentRole } from '../agents/prompt-helpers.js';

import { posix, resolve } from 'path';

function normalizeForCompare(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

function canonicalizePath(path: string): string {
  const slashNormalized = path.replaceAll('\\', '/');
  const hasWindowsDrive = /^[A-Za-z]:\//.test(slashNormalized);

  if (slashNormalized.startsWith('/') && !hasWindowsDrive) {
    return normalizeForCompare(posix.normalize(slashNormalized));
  }

  return normalizeForCompare(resolve(path));
}

/**
 * Subagent mode marker prepended to all prompts sent to external CLI agents.
 * Prevents recursive subagent spawning within subagent tool calls.
 */
export const SUBAGENT_HEADER = `[SUBAGENT MODE] You are a subagent running inside a tool call.
DO NOT spawn additional subagents or invoke Codex/Gemini CLI recursively.
Complete the task directly with your available tools.`;

/**
 * Validate context file paths for use as external model context.
 * Rejects paths with control characters (prompt injection) and paths that
 * escape the base directory (path traversal).
 */
export function validateContextFilePaths(
  paths: string[],
  baseDir: string,
  allowExternal = false
): { validPaths: string[]; errors: string[] } {
  const validPaths: string[] = [];
  const errors: string[] = [];
  const resolvedBase = canonicalizePath(baseDir);

  for (const p of paths) {
    // Injection check: reject control characters (\n, \r, \0)
    if (/[\n\r\0]/.test(p)) {
      errors.push(`E_CONTEXT_FILE_INJECTION: Path contains control characters: ${p.slice(0, 80)}`);
      continue;
    }

    if (!allowExternal) {
      // Traversal check: resolved absolute path must remain within baseDir
      const abs = canonicalizePath(p.replaceAll('\\', '/').startsWith('/') ? p : `${baseDir}/${p}`);
      if (!abs.startsWith(`${resolvedBase}/`) && abs !== resolvedBase) {
        errors.push(`E_CONTEXT_FILE_TRAVERSAL: Path escapes baseDir: ${p}`);
        continue;
      }
    }

    validPaths.push(p);
  }

  return { validPaths, errors };
}

/**
 * Build the full prompt for an external CLI agent.
 * Always prepends SUBAGENT_HEADER to prevent recursive agent spawning.
 * Order: SUBAGENT_HEADER > system_prompt > file_context > user_prompt
 */
export function buildPromptWithSystemContext(
  userPrompt: string,
  fileContext: string | undefined,
  systemPrompt: string | undefined
): string {
  const parts: string[] = [SUBAGENT_HEADER];

  if (systemPrompt) {
    parts.push(`<system-instructions>\n${systemPrompt}\n</system-instructions>`);
  }

  if (fileContext) {
    parts.push(fileContext);
  }

  parts.push(userPrompt);

  return parts.join('\n\n');
}
