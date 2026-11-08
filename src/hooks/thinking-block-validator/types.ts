/**
 * Thinking Block Validator Types
 *
 * Type definitions for validating and fixing thinking blocks in assistant messages.
 *
 * Ported from oh-my-opencode's thinking-block-validator hook.
 */

/**
 * Message part representing different content types
 */
export interface MessagePart {
  type: string;
  id?: string;
  sessionID?: string;
  messageID?: string;
  thinking?: string;
  text?: string;
  synthetic?: boolean;
}

/**
 * Message information
 */
export interface MessageInfo {
  id: string;
  role: 'user' | 'assistant' | 'system';
  sessionID?: string;
  modelID?: string;
}

/**
 * Message with parts array
 */
export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

/**
 * Input for messages transform hook
 */
export interface MessagesTransformInput {
  messages: MessageWithParts[];
}

/**
 * Output for messages transform hook
 */
export interface MessagesTransformOutput {
  messages: MessageWithParts[];
}

/**
 * Hook for transforming messages before API call
 */
export interface MessagesTransformHook {
  "experimental.chat.messages.transform"?: (
    input: Record<string, never>,
    output: MessagesTransformOutput
  ) => Promise<void>;
}

/**
 * Validation result for a message
 */
export interface ValidationResult {
  /** Whether the message is valid */
  valid: boolean;
  /** Whether the message was fixed */
  fixed: boolean;
  /** Description of the issue found */
  issue?: string;
  /** Action taken to fix the issue */
  action?: string;
}
