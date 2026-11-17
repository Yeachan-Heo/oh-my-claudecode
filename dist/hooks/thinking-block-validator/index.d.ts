/**
 * Proactive Thinking Block Validator Hook
 *
 * Prevents "Expected thinking/redacted_thinking but found tool_use" errors
 * by validating and fixing message structure BEFORE sending to Anthropic API.
 *
 * This hook runs on the "experimental.chat.messages.transform" hook point,
 * which is called before messages are converted to ModelMessage format and
 * sent to the API.
 *
 * Key differences from session-recovery hook:
 * - PROACTIVE (prevents error) vs REACTIVE (fixes after error)
 * - Runs BEFORE API call vs AFTER API error
 * - User never sees the error vs User sees error then recovery
 *
 * Ported from oh-my-opencode's thinking-block-validator hook.
 */
import type { MessagePart, MessageWithParts, MessagesTransformHook, ValidationResult } from "./types.js";
export * from "./types.js";
export * from "./constants.js";
export declare function isExtendedThinkingModel(modelID: string): boolean;
export declare function hasContentParts(parts: MessagePart[]): boolean;
export declare function startsWithThinkingBlock(parts: MessagePart[]): boolean;
export declare function findPreviousThinkingContent(messages: MessageWithParts[], currentIndex: number): string;
export declare function prependThinkingBlock(message: MessageWithParts, thinkingContent: string): void;
export declare function validateMessage(message: MessageWithParts, messages: MessageWithParts[], index: number, modelID: string): ValidationResult;
export declare function createThinkingBlockValidatorHook(): MessagesTransformHook;
export declare function validateMessages(messages: MessageWithParts[], modelID: string): ValidationResult[];
export declare function getValidationStats(results: ValidationResult[]): {
    total: number;
    valid: number;
    fixed: number;
    issues: number;
};
//# sourceMappingURL=index.d.ts.map