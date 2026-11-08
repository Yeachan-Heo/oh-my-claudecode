/**
 * Prompt Echo Truncation
 *
 * Stop-hook feedback messages re-echo the original task prompt so the model
 * remembers what it was doing.  When that prompt is long (e.g. a multi-paragraph
 * ralph invocation) the full text is injected on *every* stop event, burning
 * context tokens unnecessarily.
 *
 * This module caps the echoed text to a compact length that still preserves
 * enough task identity to be useful.
 *
 * @see https://github.com/anthropics/claude-code/issues/2542
 */
/** Default character cap for echoed task prompts in stop-hook feedback. */
export declare const DEFAULT_PROMPT_ECHO_MAX_CHARS = 150;
/**
 * Truncate a task prompt to a compact length suitable for stop-hook echo.
 *
 * - If `prompt` fits within `maxChars` it is returned unchanged.
 * - Otherwise it is sliced to `maxChars` and an ellipsis ("…") is appended.
 * - Leading/trailing whitespace is trimmed before the length check so that
 *   prompts that are only whitespace-padded don't sneak past the cap.
 *
 * @param prompt   The original task description stored in mode state.
 * @param maxChars Maximum number of characters to include (default 150).
 * @returns        The prompt, guaranteed to be ≤ maxChars + 1 chars long.
 */
export declare function truncatePromptForEcho(prompt: string, maxChars?: number): string;
//# sourceMappingURL=truncate-prompt.d.ts.map