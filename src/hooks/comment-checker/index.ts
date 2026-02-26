/**
 * Comment Checker Hook
 *
 * Detects comments and docstrings in code changes and prompts Claude
 * to justify or remove unnecessary comments.
 *
 * Adapted from oh-my-opencode's comment-checker hook.
 * Instead of using an external CLI binary, this implementation does
 * comment detection directly in TypeScript.
 */

import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import {
  HOOK_MESSAGE_HEADER,
  LINE_COMMENT_PATTERNS,
  EXTENSION_TO_LANGUAGE,
} from './constants.js';
import { applyFilters } from './filters.js';
import type { CommentInfo, CommentCheckResult, PendingCall } from './types.js';

const DEBUG = process.env.COMMENT_CHECKER_DEBUG === '1';
const DEBUG_FILE = path.join(tmpdir(), 'comment-checker-debug.log');

function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    const msg = `[${new Date().toISOString()}] [comment-checker] ${args
      .map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)))
      .join(' ')}\n`;
    fs.appendFileSync(DEBUG_FILE, msg);
  }
}

/**
 * Get language from file extension
 */
function getLanguageFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext];
}

/**
 * Detect comments in content using regex patterns
 */
function detectComments(content: string, filePath: string): CommentInfo[] {
  const language = getLanguageFromPath(filePath);
  if (!language) {
    debugLog('unsupported language for:', filePath);
    return [];
  }

  const pattern = LINE_COMMENT_PATTERNS[language];
  if (!pattern) {
    debugLog('no pattern for language:', language);
    return [];
  }

  const comments: CommentInfo[] = [];
  const _lines = content.split('\n');

  // Reset regex state
  pattern.lastIndex = 0;

  let match;
  while ((match = pattern.exec(content)) !== null) {
    const matchStart = match.index;
    const matchText = match[0];

    // Calculate line number
    const beforeMatch = content.substring(0, matchStart);
    const lineNumber = beforeMatch.split('\n').length;

    // Determine comment type
    let commentType: 'line' | 'block' | 'docstring' = 'line';
    let isDocstring = false;

    if (matchText.startsWith('/*') || matchText.startsWith('<!--')) {
      commentType = 'block';
    } else if (
      matchText.startsWith("'''") ||
      matchText.startsWith('"""') ||
      matchText.startsWith('=begin')
    ) {
      commentType = 'docstring';
      isDocstring = true;
    }

    comments.push({
      text: matchText.trim(),
      lineNumber,
      filePath,
      commentType,
      isDocstring,
    });
  }

  return comments;
}

/**
 * Extract comments from new content (for Write tool)
 */
function extractCommentsFromContent(
  content: string,
  filePath: string
): CommentInfo[] {
  return detectComments(content, filePath);
}

/**
 * Extract comments from new string (for Edit tool)
 */
function extractCommentsFromEdit(
  newString: string,
  filePath: string,
  oldString?: string
): CommentInfo[] {
  // Only check comments that are newly added
  const newComments = detectComments(newString, filePath);

  if (oldString) {
    const oldComments = detectComments(oldString, filePath);
    const oldTexts = new Set(oldComments.map((c) => c.text));

    // Filter out comments that existed before
    return newComments.filter((c) => !oldTexts.has(c.text));
  }

  return newComments;
}

/**
 * Format comments for output message
 */
function formatCommentMessage(comments: CommentInfo[]): string {
  if (comments.length === 0) {
    return '';
  }

  const grouped = new Map<string, CommentInfo[]>();
  for (const comment of comments) {
    const existing = grouped.get(comment.filePath) || [];
    existing.push(comment);
    grouped.set(comment.filePath, existing);
  }

  let message = HOOK_MESSAGE_HEADER;

  for (const [filePath, fileComments] of grouped) {
    message += `\nFile: ${filePath}\n`;
    for (const comment of fileComments) {
      const typeLabel = comment.isDocstring ? 'docstring' : comment.commentType;
      message += `  Line ${comment.lineNumber} (${typeLabel}): ${comment.text.substring(0, 100)}${comment.text.length > 100 ? '...' : ''}\n`;
    }
  }

  return message;
}

/**
 * Check content for comments
 */
export function checkForComments(
  filePath: string,
  content?: string,
  oldString?: string,
  newString?: string,
  edits?: Array<{ old_string: string; new_string: string }>
): CommentCheckResult {
  let allComments: CommentInfo[] = [];

  if (content) {
    // Write tool - check entire content
    allComments = extractCommentsFromContent(content, filePath);
  } else if (newString) {
    // Edit tool - check new content
    allComments = extractCommentsFromEdit(newString, filePath, oldString);
  } else if (edits && edits.length > 0) {
    // MultiEdit tool - check all edits
    for (const edit of edits) {
      const editComments = extractCommentsFromEdit(
        edit.new_string,
        filePath,
        edit.old_string
      );
      allComments.push(...editComments);
    }
  }

  // Apply filters to remove acceptable comments
  const flaggedComments = applyFilters(allComments);

  debugLog(
    `found ${allComments.length} comments, ${flaggedComments.length} flagged after filtering`
  );

  if (flaggedComments.length === 0) {
    return {
      hasComments: false,
      count: 0,
      comments: [],
    };
  }

  return {
    hasComments: true,
    count: flaggedComments.length,
    message: formatCommentMessage(flaggedComments),
    comments: flaggedComments,
  };
}

/**
 * Configuration for comment checker hook
 */
export interface CommentCheckerConfig {
  /** Custom prompt to append instead of default */
  customPrompt?: string;
  /** Whether to enable the hook */
  enabled?: boolean;
}

/**
 * Pending calls tracking
 */
const pendingCalls = new Map<string, PendingCall>();
const PENDING_CALL_TTL = 60_000;

function cleanupOldPendingCalls(): void {
  const now = Date.now();
  for (const [callID, call] of pendingCalls) {
    if (now - call.timestamp > PENDING_CALL_TTL) {
      pendingCalls.delete(callID);
    }
  }
}

let cleanupIntervalStarted = false;

/**
 * Create comment checker hook for Claude Code shell hooks
 *
 * This hook checks for comments in Write/Edit operations and injects
 * a message prompting Claude to justify or remove unnecessary comments.
 */
export function createCommentCheckerHook(config?: CommentCheckerConfig) {
  debugLog('createCommentCheckerHook called', { config });

  if (!cleanupIntervalStarted) {
    cleanupIntervalStarted = true;
    // Note: setInterval is intentionally NOT used here — this module runs in
    // short-lived hook processes that exit before any timer fires. Pending
    // calls are cleaned up lazily via TTL checks on the next invocation.
  }

  return {
    /**
     * PreToolUse - Track pending write/edit calls
     */
    preToolUse: (input: {
      tool_name: string;
      session_id: string;
      tool_input: Record<string, unknown>;
    }): { decision: string } | null => {
      const toolLower = input.tool_name.toLowerCase();

      if (
        toolLower !== 'write' &&
        toolLower !== 'edit' &&
        toolLower !== 'multiedit'
      ) {
        return null;
      }

      const filePath = (input.tool_input.file_path ??
        input.tool_input.filePath ??
        input.tool_input.path) as string | undefined;
      const content = input.tool_input.content as string | undefined;
      const oldString = (input.tool_input.old_string ??
        input.tool_input.oldString) as string | undefined;
      const newString = (input.tool_input.new_string ??
        input.tool_input.newString) as string | undefined;
      const edits = input.tool_input.edits as
        | Array<{ old_string: string; new_string: string }>
        | undefined;

      if (!filePath) {
        return null;
      }

      // Generate a call ID based on session and timestamp
      const callId = `${input.session_id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      debugLog('registering pendingCall:', {
        callId,
        filePath,
        tool: toolLower,
      });

      pendingCalls.set(callId, {
        filePath,
        content,
        oldString,
        newString,
        edits,
        tool: toolLower as 'write' | 'edit' | 'multiedit',
        sessionId: input.session_id,
        timestamp: Date.now(),
      });

      return null;
    },

    /**
     * PostToolUse - Check for comments after successful write/edit
     */
    postToolUse: (input: {
      tool_name: string;
      session_id: string;
      tool_input: Record<string, unknown>;
      tool_response?: string;
    }): string | null => {
      const toolLower = input.tool_name.toLowerCase();

      if (
        toolLower !== 'write' &&
        toolLower !== 'edit' &&
        toolLower !== 'multiedit'
      ) {
        return null;
      }

      // Find the pending call for this session
      let pendingCall: PendingCall | undefined;
      let callIdToDelete: string | undefined;

      for (const [callId, call] of pendingCalls) {
        if (call.sessionId === input.session_id && call.tool === toolLower) {
          pendingCall = call;
          callIdToDelete = callId;
          break;
        }
      }

      if (!pendingCall) {
        // Fall back to extracting from tool_input
        const filePath = (input.tool_input.file_path ??
          input.tool_input.filePath ??
          input.tool_input.path) as string | undefined;

        if (!filePath) {
          return null;
        }

        pendingCall = {
          filePath,
          content: input.tool_input.content as string | undefined,
          oldString: (input.tool_input.old_string ??
            input.tool_input.oldString) as string | undefined,
          newString: (input.tool_input.new_string ??
            input.tool_input.newString) as string | undefined,
          edits: input.tool_input.edits as
            | Array<{ old_string: string; new_string: string }>
            | undefined,
          tool: toolLower as 'write' | 'edit' | 'multiedit',
          sessionId: input.session_id,
          timestamp: Date.now(),
        };
      }

      if (callIdToDelete) {
        pendingCalls.delete(callIdToDelete);
      }

      // Check if tool execution failed
      if (input.tool_response) {
        const responseLower = input.tool_response.toLowerCase();
        const isToolFailure =
          responseLower.includes('error:') ||
          responseLower.includes('failed to') ||
          responseLower.includes('could not') ||
          responseLower.startsWith('error');

        if (isToolFailure) {
          debugLog('skipping due to tool failure in response');
          return null;
        }
      }

      // Check for comments
      const result = checkForComments(
        pendingCall.filePath,
        pendingCall.content,
        pendingCall.oldString,
        pendingCall.newString,
        pendingCall.edits
      );

      if (result.hasComments && result.message) {
        debugLog('detected comments, returning message');
        return config?.customPrompt || result.message;
      }

      return null;
    },
  };
}

// Re-export types
export type { CommentInfo, CommentCheckResult, PendingCall } from './types.js';

// Re-export filters
export { applyFilters } from './filters.js';

// Re-export constants
export {
  BDD_KEYWORDS,
  TYPE_CHECKER_PREFIXES,
  HOOK_MESSAGE_HEADER,
  LINE_COMMENT_PATTERNS,
  EXTENSION_TO_LANGUAGE,
} from './constants.js';
