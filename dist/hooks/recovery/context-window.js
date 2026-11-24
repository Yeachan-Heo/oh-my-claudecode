/**
 * Context Window Limit Recovery
 *
 * Detects context window limit errors and injects recovery messages
 * to help Claude recover gracefully.
 */
import * as fs from 'fs';
import { TOKEN_LIMIT_PATTERNS, TOKEN_LIMIT_KEYWORDS, CONTEXT_LIMIT_RECOVERY_MESSAGE, CONTEXT_LIMIT_SHORT_MESSAGE, NON_EMPTY_CONTENT_RECOVERY_MESSAGE, RECOVERY_FAILED_MESSAGE, DEBUG, DEBUG_FILE, } from './constants.js';
import { RETRY_CONFIG } from './types.js';
function debugLog(...args) {
    if (DEBUG) {
        const msg = `[${new Date().toISOString()}] [context-window-recovery] ${args
            .map((a) => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))
            .join(' ')}\n`;
        fs.appendFileSync(DEBUG_FILE, msg);
    }
}
const sessionStates = new Map();
const STATE_TTL = 300_000; // 5 minutes
/**
 * Remove session state for a given session ID (call on context window exhaustion).
 */
export function clearSessionState(sessionId) {
    sessionStates.delete(sessionId);
}
/**
 * GC: remove all session state entries older than STATE_TTL.
 * Called automatically on context window exhaustion to free memory.
 */
function gcSessionStates() {
    const now = Date.now();
    for (const [id, state] of sessionStates.entries()) {
        if (now - state.lastErrorTime > STATE_TTL) {
            sessionStates.delete(id);
        }
    }
}
/**
 * Patterns indicating thinking block structure errors (NOT token limit)
 */
const THINKING_BLOCK_ERROR_PATTERNS = [
    /thinking.*first block/i,
    /first block.*thinking/i,
    /must.*start.*thinking/i,
    /thinking.*redacted_thinking/i,
    /expected.*thinking.*found/i,
    /thinking.*disabled.*cannot.*contain/i,
];
/**
 * Check if error is a thinking block structure error
 */
function isThinkingBlockError(text) {
    return THINKING_BLOCK_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}
/**
 * Check if text indicates a token limit error
 */
function isTokenLimitError(text) {
    if (isThinkingBlockError(text)) {
        return false;
    }
    const lower = text.toLowerCase();
    return TOKEN_LIMIT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}
/**
 * Extract token counts from error message
 */
function extractTokensFromMessage(message) {
    for (const pattern of TOKEN_LIMIT_PATTERNS) {
        const match = message.match(pattern);
        if (match) {
            const num1 = parseInt(match[1], 10);
            const num2 = parseInt(match[2], 10);
            return num1 > num2
                ? { current: num1, max: num2 }
                : { current: num2, max: num1 };
        }
    }
    return null;
}
/**
 * Extract message index from error text
 */
function extractMessageIndex(text) {
    const match = text.match(/messages\.(\d+)/);
    if (match) {
        return parseInt(match[1], 10);
    }
    return undefined;
}
/**
 * Parse an error to detect if it's a token limit error
 */
export function parseTokenLimitError(err) {
    // Handle string errors
    if (typeof err === 'string') {
        if (err.toLowerCase().includes('non-empty content')) {
            return {
                currentTokens: 0,
                maxTokens: 0,
                errorType: 'non-empty content',
                messageIndex: extractMessageIndex(err),
            };
        }
        if (isTokenLimitError(err)) {
            const tokens = extractTokensFromMessage(err);
            return {
                currentTokens: tokens?.current ?? 0,
                maxTokens: tokens?.max ?? 0,
                errorType: 'token_limit_exceeded_string',
            };
        }
        return null;
    }
    // Handle non-object errors
    if (!err || typeof err !== 'object')
        return null;
    const errObj = err;
    // Collect all text sources from the error object
    const textSources = [];
    const dataObj = errObj.data;
    const responseBody = dataObj?.responseBody;
    const errorMessage = errObj.message;
    const errorData = errObj.error;
    const nestedError = errorData?.error;
    if (typeof responseBody === 'string')
        textSources.push(responseBody);
    if (typeof errorMessage === 'string')
        textSources.push(errorMessage);
    if (typeof errorData?.message === 'string')
        textSources.push(errorData.message);
    if (typeof errObj.body === 'string')
        textSources.push(errObj.body);
    if (typeof errObj.details === 'string')
        textSources.push(errObj.details);
    if (typeof errObj.reason === 'string')
        textSources.push(errObj.reason);
    if (typeof errObj.description === 'string')
        textSources.push(errObj.description);
    if (typeof nestedError?.message === 'string')
        textSources.push(nestedError.message);
    if (typeof dataObj?.message === 'string')
        textSources.push(dataObj.message);
    if (typeof dataObj?.error === 'string')
        textSources.push(dataObj.error);
    // Try JSON stringification if no text sources found
    if (textSources.length === 0) {
        try {
            const jsonStr = JSON.stringify(errObj);
            if (isTokenLimitError(jsonStr)) {
                textSources.push(jsonStr);
            }
        }
        catch {
            // Ignore JSON errors
        }
    }
    const combinedText = textSources.join(' ');
    if (!isTokenLimitError(combinedText))
        return null;
    // Try to parse structured response body
    if (typeof responseBody === 'string') {
        try {
            const jsonPatterns = [
                /data:\s*(\{[\s\S]*\})\s*$/m,
                /(\{"type"\s*:\s*"error"[\s\S]*\})/,
                /(\{[\s\S]*"error"[\s\S]*\})/,
            ];
            for (const pattern of jsonPatterns) {
                const dataMatch = responseBody.match(pattern);
                if (dataMatch) {
                    try {
                        const jsonData = JSON.parse(dataMatch[1]);
                        const message = jsonData.error?.message || '';
                        const tokens = extractTokensFromMessage(message);
                        if (tokens) {
                            return {
                                currentTokens: tokens.current,
                                maxTokens: tokens.max,
                                requestId: jsonData.request_id,
                                errorType: jsonData.error?.type || 'token_limit_exceeded',
                            };
                        }
                    }
                    catch {
                        // Ignore parse errors
                    }
                }
            }
            // Check for Bedrock-style errors
            const bedrockJson = JSON.parse(responseBody);
            if (typeof bedrockJson.message === 'string' &&
                isTokenLimitError(bedrockJson.message)) {
                return {
                    currentTokens: 0,
                    maxTokens: 0,
                    errorType: 'bedrock_input_too_long',
                };
            }
        }
        catch {
            // Ignore parse errors
        }
    }
    // Extract tokens from any text source
    for (const text of textSources) {
        const tokens = extractTokensFromMessage(text);
        if (tokens) {
            return {
                currentTokens: tokens.current,
                maxTokens: tokens.max,
                errorType: 'token_limit_exceeded',
            };
        }
    }
    // Check for non-empty content error
    if (combinedText.toLowerCase().includes('non-empty content')) {
        return {
            currentTokens: 0,
            maxTokens: 0,
            errorType: 'non-empty content',
            messageIndex: extractMessageIndex(combinedText),
        };
    }
    // Generic token limit error
    if (isTokenLimitError(combinedText)) {
        return {
            currentTokens: 0,
            maxTokens: 0,
            errorType: 'token_limit_exceeded_unknown',
        };
    }
    return null;
}
/**
 * Check if text contains a context limit error
 */
export function containsTokenLimitError(text) {
    return isTokenLimitError(text);
}
/**
 * Get or create session state
 */
function getSessionState(sessionId) {
    let state = sessionStates.get(sessionId);
    const now = Date.now();
    // Reset stale state and remove expired entry from Map
    if (state && now - state.lastErrorTime > STATE_TTL) {
        sessionStates.delete(sessionId);
        state = undefined;
    }
    if (!state) {
        state = {
            retryState: { attempt: 0, lastAttemptTime: 0 },
            truncateState: { truncateAttempt: 0 },
            lastErrorTime: now,
            errorCount: 0,
        };
        sessionStates.set(sessionId, state);
    }
    return state;
}
/**
 * Generate appropriate recovery message based on error and state
 */
function generateRecoveryMessage(parsed, state, config) {
    // Use custom message if provided
    if (config?.customMessages?.context_window_limit) {
        return {
            message: config.customMessages.context_window_limit,
            errorType: parsed?.errorType,
        };
    }
    // Handle non-empty content error
    if (parsed?.errorType?.includes('non-empty content')) {
        return {
            message: NON_EMPTY_CONTENT_RECOVERY_MESSAGE,
            errorType: 'non-empty content',
        };
    }
    // Check retry limits
    state.retryState.attempt++;
    state.retryState.lastAttemptTime = Date.now();
    if (state.retryState.attempt > RETRY_CONFIG.maxAttempts) {
        return {
            message: RECOVERY_FAILED_MESSAGE,
            errorType: 'recovery_exhausted',
        };
    }
    // Return detailed or short message based on config
    if (config?.detailed !== false) {
        let message = CONTEXT_LIMIT_RECOVERY_MESSAGE;
        // Add token info if available
        if (parsed?.currentTokens && parsed?.maxTokens) {
            message += `\nToken Details:
- Current: ${parsed.currentTokens.toLocaleString()} tokens
- Maximum: ${parsed.maxTokens.toLocaleString()} tokens
- Over limit by: ${(parsed.currentTokens - parsed.maxTokens).toLocaleString()} tokens
`;
        }
        return {
            message,
            errorType: parsed?.errorType || 'token_limit_exceeded',
        };
    }
    return {
        message: CONTEXT_LIMIT_SHORT_MESSAGE,
        errorType: parsed?.errorType || 'token_limit_exceeded',
    };
}
/**
 * Handle context window limit recovery
 */
export function handleContextWindowRecovery(sessionId, error, config) {
    const parsed = parseTokenLimitError(error);
    if (!parsed) {
        return {
            attempted: false,
            success: false,
        };
    }
    debugLog('detected token limit error', { sessionId, parsed });
    // GC stale session state on every context window exhaustion event
    gcSessionStates();
    const state = getSessionState(sessionId);
    state.lastErrorTime = Date.now();
    state.errorCount++;
    const recovery = generateRecoveryMessage(parsed, state, config);
    return {
        attempted: true,
        success: !!recovery.message,
        message: recovery.message,
        errorType: recovery.errorType,
    };
}
/**
 * Check if text contains a context limit error
 */
export function detectContextLimitError(text) {
    return containsTokenLimitError(text);
}
//# sourceMappingURL=context-window.js.map