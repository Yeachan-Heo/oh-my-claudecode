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
import { HOOK_MESSAGE_HEADER, LINE_COMMENT_PATTERNS, EXTENSION_TO_LANGUAGE, } from './constants.js';
import { applyFilters } from './filters.js';
const DEBUG = process.env.COMMENT_CHECKER_DEBUG === '1';
const DEBUG_FILE = path.join(tmpdir(), 'comment-checker-debug.log');
function debugLog(...args) {
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
function getLanguageFromPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_TO_LANGUAGE[ext];
}
/**
 * Detect comments in content using regex patterns
 */
function detectComments(content, filePath) {
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
    const comments = [];
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
        let commentType = 'line';
        let isDocstring = false;
        if (matchText.startsWith('/*') || matchText.startsWith('<!--')) {
            commentType = 'block';
        }
        else if (matchText.startsWith("'''") ||
            matchText.startsWith('"""') ||
            matchText.startsWith('=begin')) {
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
function extractCommentsFromContent(content, filePath) {
    return detectComments(content, filePath);
}
/**
 * Extract comments from new string (for Edit tool)
 */
function extractCommentsFromEdit(newString, filePath, oldString) {
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
function formatCommentMessage(comments) {
    if (comments.length === 0) {
        return '';
    }
    const grouped = new Map();
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
export function checkForComments(filePath, content, oldString, newString, edits) {
    let allComments = [];
    if (content) {
        // Write tool - check entire content
        allComments = extractCommentsFromContent(content, filePath);
    }
    else if (newString) {
        // Edit tool - check new content
        allComments = extractCommentsFromEdit(newString, filePath, oldString);
    }
    else if (edits && edits.length > 0) {
        // MultiEdit tool - check all edits
        for (const edit of edits) {
            const editComments = extractCommentsFromEdit(edit.new_string, filePath, edit.old_string);
            allComments.push(...editComments);
        }
    }
    // Apply filters to remove acceptable comments
    const flaggedComments = applyFilters(allComments);
    debugLog(`found ${allComments.length} comments, ${flaggedComments.length} flagged after filtering`);
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
 * Pending calls tracking
 */
const pendingCalls = new Map();
const PENDING_CALL_TTL = 60_000;
function cleanupOldPendingCalls() {
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
export function createCommentCheckerHook(config) {
    debugLog('createCommentCheckerHook called', { config });
    if (!cleanupIntervalStarted) {
        cleanupIntervalStarted = true;
        setInterval(cleanupOldPendingCalls, 10_000);
    }
    return {
        /**
         * PreToolUse - Track pending write/edit calls
         */
        preToolUse: (input) => {
            const toolLower = input.tool_name.toLowerCase();
            if (toolLower !== 'write' &&
                toolLower !== 'edit' &&
                toolLower !== 'multiedit') {
                return null;
            }
            const filePath = (input.tool_input.file_path ??
                input.tool_input.filePath ??
                input.tool_input.path);
            const content = input.tool_input.content;
            const oldString = (input.tool_input.old_string ??
                input.tool_input.oldString);
            const newString = (input.tool_input.new_string ??
                input.tool_input.newString);
            const edits = input.tool_input.edits;
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
                tool: toolLower,
                sessionId: input.session_id,
                timestamp: Date.now(),
            });
            return null;
        },
        /**
         * PostToolUse - Check for comments after successful write/edit
         */
        postToolUse: (input) => {
            const toolLower = input.tool_name.toLowerCase();
            if (toolLower !== 'write' &&
                toolLower !== 'edit' &&
                toolLower !== 'multiedit') {
                return null;
            }
            // Find the pending call for this session
            let pendingCall;
            let callIdToDelete;
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
                    input.tool_input.path);
                if (!filePath) {
                    return null;
                }
                pendingCall = {
                    filePath,
                    content: input.tool_input.content,
                    oldString: (input.tool_input.old_string ??
                        input.tool_input.oldString),
                    newString: (input.tool_input.new_string ??
                        input.tool_input.newString),
                    edits: input.tool_input.edits,
                    tool: toolLower,
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
                const isToolFailure = responseLower.includes('error:') ||
                    responseLower.includes('failed to') ||
                    responseLower.includes('could not') ||
                    responseLower.startsWith('error');
                if (isToolFailure) {
                    debugLog('skipping due to tool failure in response');
                    return null;
                }
            }
            // Check for comments
            const result = checkForComments(pendingCall.filePath, pendingCall.content, pendingCall.oldString, pendingCall.newString, pendingCall.edits);
            if (result.hasComments && result.message) {
                debugLog('detected comments, returning message');
                return config?.customPrompt || result.message;
            }
            return null;
        },
    };
}
// Re-export filters
export { applyFilters } from './filters.js';
// Re-export constants
export { BDD_KEYWORDS, TYPE_CHECKER_PREFIXES, HOOK_MESSAGE_HEADER, LINE_COMMENT_PATTERNS, EXTENSION_TO_LANGUAGE, } from './constants.js';
//# sourceMappingURL=index.js.map