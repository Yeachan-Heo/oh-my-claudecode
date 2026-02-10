/**
 * Resume Session Tool
 *
 * Wrapper tool to resume a previous background agent session.
 * Returns context for the orchestrator to include in the next Task delegation.
 *
 * Since Claude Code's native Task tool cannot be extended, this tool provides
 * a convenient way to retrieve session context and build continuation prompts.
 */
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
 *     subagent_type: "oh-my-claudecode:executor",
 *     model: "sonnet",
 *     prompt: result.context.continuationPrompt
 *   });
 * }
 * ```
 */
export declare function resumeSession(input: ResumeSessionInput): ResumeSessionOutput;
//# sourceMappingURL=resume-session.d.ts.map