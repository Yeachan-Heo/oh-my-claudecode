/**
 * Unified Recovery Constants
 *
 * Constants, messages, and patterns for all recovery mechanisms.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDataDir } from '../../utils/paths.js';

/**
 * Get the Claude Code storage directory
 */
function getClaudeCodeStorageDir(): string {
  return join(getDataDir(), 'claude-code', 'storage');
}

export const CLAUDE_CODE_STORAGE = getClaudeCodeStorageDir();
export const MESSAGE_STORAGE = join(CLAUDE_CODE_STORAGE, 'message');
export const PART_STORAGE = join(CLAUDE_CODE_STORAGE, 'part');

/**
 * Debug logging configuration
 */
export const DEBUG =
  process.env.RECOVERY_DEBUG === '1' ||
  process.env.CONTEXT_LIMIT_RECOVERY_DEBUG === '1' ||
  process.env.SESSION_RECOVERY_DEBUG === '1';

export const DEBUG_FILE = join(tmpdir(), 'recovery-debug.log');

/**
 * Part type sets for categorization
 */
export const THINKING_TYPES = new Set(['thinking', 'redacted_thinking', 'reasoning']);
export const META_TYPES = new Set(['step-start', 'step-finish']);
export const CONTENT_TYPES = new Set(['text', 'tool', 'tool_use', 'tool_result']);

/**
 * Placeholder text for empty content
 */
export const PLACEHOLDER_TEXT = '[user interrupted]';

/**
 * ============================================================================
 * CONTEXT WINDOW LIMIT RECOVERY
 * ============================================================================
 */

/**
 * Recovery message when context window limit is hit
 */
export const CONTEXT_LIMIT_RECOVERY_MESSAGE = `CONTEXT WINDOW LIMIT REACHED - IMMEDIATE ACTION REQUIRED

The conversation has exceeded the model's context window limit. To continue working effectively, you must take one of these actions:

1. SUMMARIZE THE CONVERSATION
   - Use the /compact command if available
   - Or provide a concise summary of what has been accomplished so far
   - Include key decisions, code changes, and remaining tasks

2. START A FRESH CONTEXT
   - If summarization isn't sufficient, suggest starting a new session
   - Provide a handoff message with essential context

3. REDUCE OUTPUT SIZE
   - When showing code, show only relevant portions
   - Use file paths and line numbers instead of full code blocks
   - Be more concise in explanations

IMPORTANT: Do not attempt to continue without addressing this limit.
The API will reject further requests until the context is reduced.

Current Status:
- Context limit exceeded
- Further API calls will fail until context is reduced
- Action required before continuing
`;

/**
 * Short notification for context limit
 */
export const CONTEXT_LIMIT_SHORT_MESSAGE = `Context window limit reached. Please use /compact to summarize the conversation or start a new session.`;

/**
 * Recovery message for non-empty content errors
 */
export const NON_EMPTY_CONTENT_RECOVERY_MESSAGE = `API ERROR: Non-empty content validation failed.

This error typically occurs when:
- A message has empty text content
- The conversation structure is invalid

Suggested actions:
1. Continue with a new message
2. If the error persists, start a new session

The system will attempt automatic recovery.
`;

/**
 * Recovery message when truncation was applied
 */
export const TRUNCATION_APPLIED_MESSAGE = `CONTEXT OPTIMIZATION APPLIED

Some tool outputs have been truncated to fit within the context window.
The conversation can now continue normally.

If you need to see the full output of a previous tool call, you can:
- Re-run the specific command
- Ask to see a particular file or section

Continuing with the current task...
`;

/**
 * Message when recovery fails
 */
export const RECOVERY_FAILED_MESSAGE = `CONTEXT RECOVERY FAILED

All automatic recovery attempts have been exhausted.
Please start a new session to continue.

Before starting a new session:
1. Note what has been accomplished
2. Save any important code changes
3. Document the current state of the task

You can copy this conversation summary to continue in a new session.
`;

/**
 * Patterns to extract token counts from error messages
 */
export const TOKEN_LIMIT_PATTERNS = [
  /(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i,
  /prompt.*?(\d+).*?tokens.*?exceeds.*?(\d+)/i,
  /(\d+).*?tokens.*?limit.*?(\d+)/i,
  /context.*?length.*?(\d+).*?maximum.*?(\d+)/i,
  /max.*?context.*?(\d+).*?but.*?(\d+)/i,
];

/**
 * Keywords indicating token limit errors
 */
export const TOKEN_LIMIT_KEYWORDS = [
  'prompt is too long',
  'is too long',
  'context_length_exceeded',
  'max_tokens',
  'token limit',
  'context length',
  'too many tokens',
  'non-empty content',
];

/**
 * ============================================================================
 * EDIT ERROR RECOVERY
 * ============================================================================
 */

/**
 * Known Edit tool error patterns that indicate the AI made a mistake
 */
export const EDIT_ERROR_PATTERNS = [
  'oldString and newString must be different',
  'oldString not found',
  'oldString found multiple times',
  'old_string not found',
  'old_string and new_string must be different',
] as const;

/**
 * System reminder injected when Edit tool fails due to AI mistake
 * Short, direct, and commanding - forces immediate corrective action
 */
export const EDIT_ERROR_REMINDER = `
[EDIT ERROR - IMMEDIATE ACTION REQUIRED]

You made an Edit mistake. STOP and do this NOW:

1. READ the file immediately to see its ACTUAL current state
2. VERIFY what the content really looks like (your assumption was wrong)
3. APOLOGIZE briefly to the user for the error
4. CONTINUE with corrected action based on the real file content

DO NOT attempt another edit until you've read and verified the file state.
`;

/**
 * ============================================================================
 * SESSION RECOVERY
 * ============================================================================
 */

/**
 * Recovery messages for different error types
 */
export const RECOVERY_MESSAGES = {
  tool_result_missing: {
    title: 'Tool Crash Recovery',
    message: 'Injecting cancelled tool results...',
  },
  thinking_block_order: {
    title: 'Thinking Block Recovery',
    message: 'Fixing message structure...',
  },
  thinking_disabled_violation: {
    title: 'Thinking Strip Recovery',
    message: 'Stripping thinking blocks...',
  },
  empty_content: {
    title: 'Empty Content Recovery',
    message: 'Adding placeholder content...',
  },
  context_window_limit: {
    title: 'Context Window Limit',
    message: 'Context limit reached - recovery required',
  },
  edit_error: {
    title: 'Edit Error',
    message: 'Edit operation failed - corrective action needed',
  },
} as const;

/**
 * Recovery error patterns
 */
export const ERROR_PATTERNS = {
  tool_result_missing: ['tool_use', 'tool_result'],
  thinking_block_order: [
    'thinking',
    'first block',
    'must start with',
    'preceeding',
    'final block',
    'cannot be thinking',
  ],
  thinking_disabled_violation: ['thinking is disabled', 'cannot contain'],
  empty_content: ['empty', 'content', 'message'],
} as const;
