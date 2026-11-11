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
export declare const HOOK_NAME = "thinking-block-validator";
/**
 * Part types that are considered "content" (non-thinking)
 */
export declare const CONTENT_PART_TYPES: readonly ["tool", "tool_use", "text"];
/**
 * Part types that are considered "thinking"
 */
export declare const THINKING_PART_TYPES: readonly ["thinking", "reasoning"];
/**
 * Model patterns that support extended thinking
 * Aligns with think-mode/switcher.ts patterns
 */
export declare const THINKING_MODEL_PATTERNS: readonly ["thinking", "-high", "claude-sonnet-4", "claude-opus-4", "claude-3"];
/**
 * Default thinking content for synthetic blocks
 */
export declare const DEFAULT_THINKING_CONTENT = "[Continuing from previous reasoning]";
/**
 * Prefix for synthetic thinking part IDs
 */
export declare const SYNTHETIC_THINKING_ID_PREFIX = "prt_0000000000_synthetic_thinking";
/**
 * Error message that this hook prevents
 */
export declare const PREVENTED_ERROR = "Expected thinking/redacted_thinking but found tool_use";
//# sourceMappingURL=constants.d.ts.map