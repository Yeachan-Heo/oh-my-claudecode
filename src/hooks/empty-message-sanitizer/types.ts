/**
 * Empty Message Sanitizer Types
 *
 * Type definitions for the empty message sanitizer hook.
 * This hook prevents API errors by ensuring all messages have valid content.
 *
 * Adapted from oh-my-opencode's empty-message-sanitizer hook.
 */

/**
 * A message part in Claude Code's message format
 */
export interface MessagePart {
  /** Unique identifier for this part */
  id?: string;
  /** Message ID this part belongs to */
  messageID?: string;
  /** Session ID this part belongs to */
  sessionID?: string;
  /** Part type (text, tool, tool_use, tool_result, etc.) */
  type: string;
  /** Text content (for text parts) */
  text?: string;
  /** Whether this is synthetically injected content */
  synthetic?: boolean;
  /** Additional properties */
  [key: string]: unknown;
}

/**
 * Message info metadata
 */
export interface MessageInfo {
  /** Message identifier */
  id: string;
  /** Message role (user, assistant) */
  role: 'user' | 'assistant';
  /** Session ID */
  sessionID?: string;
  /** Additional properties */
  [key: string]: unknown;
}

/**
 * A message with its parts
 */
export interface MessageWithParts {
  /** Message metadata */
  info: MessageInfo;
  /** Message content parts */
  parts: MessagePart[];
}

/**
 * Input for the empty message sanitizer hook
 */
export interface EmptyMessageSanitizerInput {
  /** List of messages to sanitize */
  messages: MessageWithParts[];
  /** Session identifier */
  sessionId?: string;
}

/**
 * Output from the empty message sanitizer hook
 */
export interface EmptyMessageSanitizerOutput {
  /** Sanitized messages */
  messages: MessageWithParts[];
  /** Number of messages sanitized */
  sanitizedCount: number;
  /** Whether any sanitization occurred */
  modified: boolean;
}

/**
 * Hook configuration
 */
export interface EmptyMessageSanitizerConfig {
  /** Custom placeholder text (default: "[user interrupted]") */
  placeholderText?: string;
  /** Enable debug logging */
  debug?: boolean;
}
