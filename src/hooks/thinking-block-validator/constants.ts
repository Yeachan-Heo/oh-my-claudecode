/**
 * Thinking Block Validator Constants
 *
 * Constants for validation patterns, messages, and model detection.
 *
 * Ported from oh-my-opencode's thinking-block-validator hook.
 */

/**
 * Hook name identifier
 */
export const HOOK_NAME = "thinking-block-validator";

/**
 * Part types that are considered "content" (non-thinking)
 */
export const CONTENT_PART_TYPES = [
  "tool",
  "tool_use",
  "text"
] as const;

/**
 * Part types that are considered "thinking"
 */
export const THINKING_PART_TYPES = [
  "thinking",
  "reasoning"
] as const;

/**
 * Model patterns that support extended thinking
 * Aligns with think-mode/switcher.ts patterns
 */
export const THINKING_MODEL_PATTERNS = [
  "thinking",
  "-high",
  "claude-sonnet-4",
  "claude-opus-4",
  "claude-3"
] as const;

/**
 * Default thinking content for synthetic blocks
 */
export const DEFAULT_THINKING_CONTENT = "[Continuing from previous reasoning]";

/**
 * Prefix for synthetic thinking part IDs
 */
export const SYNTHETIC_THINKING_ID_PREFIX = "prt_0000000000_synthetic_thinking";

/**
 * Error message that this hook prevents
 */
export const PREVENTED_ERROR = "Expected thinking/redacted_thinking but found tool_use";
