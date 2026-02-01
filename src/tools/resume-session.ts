/**
 * Resume Session Tool
 *
 * Wrapper tool to resume a previous background agent session.
 * Returns context for the orchestrator to include in the next Task delegation.
 *
 * Since Claude Code's native Task tool cannot be extended, this tool provides
 * a convenient way to retrieve session context and build continuation prompts.
 */

import { getBackgroundManager } from '../features/background-agent/manager.js';
import type { ResumeContext } from '../features/background-agent/types.js';

/**
 * Input for resuming a session
 */
export interface ResumeSessionInput {
  /** Session ID to resume */
  sessionId: string;
}

/**
 * Output from resume session operation
 */
export interface ResumeSessionOutput {
  /** Whether the operation succeeded */
  success: boolean;
  /** Resume context (if successful) */
  context?: {
    /** Original prompt from the session */
    previousPrompt: string;
    /** Number of tool calls made so far */
    toolCallCount: number;
    /** Last tool used (if any) */
    lastToolUsed?: string;
    /** Summary of last output (truncated to 500 chars) */
    lastOutputSummary?: string;
    /** Formatted continuation prompt to include in next Task delegation */
    continuationPrompt: string;
  };
  /** Error message (if failed) */
  error?: string;
}

/**
 * Resume a background agent session
 *
 * This tool retrieves the context from a previous background session and
 * prepares a continuation prompt that can be used when delegating to the
 * Task tool again.
 *
 * @param input - Session ID to resume
 * @returns Resume context or error
 *
 * @example
 * ```typescript
 * const result = resumeSession({ sessionId: 'ses_abc123' });
 * if (result.success && result.context) {
 *   // Use result.context.continuationPrompt in your next Task delegation
 *   Task({
 *     subagent_type: "general-purpose",
 *     model: "sonnet",
 *     prompt: result.context.continuationPrompt
 *   });
 * }
 * ```
 */
export function resumeSession(input: ResumeSessionInput): ResumeSessionOutput {
  try {
    const manager = getBackgroundManager();
    const context = manager.getResumeContext(input.sessionId);

    if (!context) {
      return {
        success: false,
        error: `Session not found: ${input.sessionId}`,
      };
    }

    // Build continuation prompt
    const continuationPrompt = buildContinuationPrompt(context);

    return {
      success: true,
      context: {
        previousPrompt: context.previousPrompt,
        toolCallCount: context.toolCallCount,
        lastToolUsed: context.lastToolUsed,
        lastOutputSummary: context.lastOutputSummary,
        continuationPrompt,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build a formatted continuation prompt from resume context
 *
 * @param context - Resume context from background manager
 * @returns Formatted prompt for next Task delegation
 */
function buildContinuationPrompt(context: ResumeContext): string {
  const parts: string[] = [];

  // Add session context header
  parts.push('# Resuming Background Session');
  parts.push('');
  parts.push(`Session ID: ${context.sessionId}`);
  parts.push(`Started: ${context.startedAt.toISOString()}`);
  parts.push(`Last Activity: ${context.lastActivityAt.toISOString()}`);
  parts.push('');

  // Add original task
  parts.push('## Original Task');
  parts.push('');
  parts.push(context.previousPrompt);
  parts.push('');

  // Add progress information
  parts.push('## Progress So Far');
  parts.push('');
  parts.push(`Tool calls executed: ${context.toolCallCount}`);

  if (context.lastToolUsed) {
    parts.push(`Last tool used: ${context.lastToolUsed}`);
  }

  if (context.lastOutputSummary) {
    parts.push('');
    parts.push('Last output:');
    parts.push('```');
    parts.push(context.lastOutputSummary);
    parts.push('```');
  }

  parts.push('');

  // Add continuation instruction
  parts.push('## Instructions');
  parts.push('');
  parts.push('Continue working on the task from where you left off.');
  parts.push('Review the progress above and complete any remaining work.');

  return parts.join('\n');
}
