/**
 * Unified Recovery Types
 *
 * Type definitions for all recovery mechanisms in Claude Code.
 */
/**
 * Recovery error types
 */
export type RecoveryErrorType = 'context_window_limit' | 'edit_error' | 'tool_result_missing' | 'thinking_block_order' | 'thinking_disabled_violation' | 'empty_content' | null;
/**
 * Recovery result
 */
export interface RecoveryResult {
    /** Whether recovery was attempted */
    attempted: boolean;
    /** Whether recovery was successful */
    success: boolean;
    /** Recovery message to inject */
    message?: string;
    /** Error type detected */
    errorType?: string;
}
/**
 * Parsed token limit error information
 */
export interface ParsedTokenLimitError {
    /** Current number of tokens in the conversation */
    currentTokens: number;
    /** Maximum allowed tokens */
    maxTokens: number;
    /** Request ID from the API response */
    requestId?: string;
    /** Type of error detected */
    errorType: string;
    /** Provider ID (e.g., 'anthropic') */
    providerID?: string;
    /** Model ID (e.g., 'claude-3-opus-20240229') */
    modelID?: string;
    /** Index of the problematic message */
    messageIndex?: number;
}
/**
 * Retry state for recovery attempts
 */
export interface RetryState {
    /** Number of retry attempts made */
    attempt: number;
    /** Timestamp of last retry attempt */
    lastAttemptTime: number;
}
/**
 * Truncation state for progressive truncation
 */
export interface TruncateState {
    /** Number of truncation attempts made */
    truncateAttempt: number;
    /** ID of the last truncated part */
    lastTruncatedPartId?: string;
}
/**
 * Message data structure
 */
export interface MessageData {
    info?: {
        id?: string;
        role?: string;
        sessionID?: string;
        parentID?: string;
        error?: unknown;
        agent?: string;
        model?: {
            providerID: string;
            modelID: string;
        };
        system?: string;
        tools?: Record<string, boolean>;
    };
    parts?: Array<{
        type: string;
        id?: string;
        text?: string;
        thinking?: string;
        name?: string;
        input?: Record<string, unknown>;
        callID?: string;
    }>;
}
/**
 * Stored message metadata
 */
export interface StoredMessageMeta {
    id: string;
    sessionID: string;
    role: 'user' | 'assistant';
    parentID?: string;
    time?: {
        created: number;
        completed?: number;
    };
    error?: unknown;
}
/**
 * Stored text part
 */
export interface StoredTextPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'text';
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
}
/**
 * Stored tool part
 */
export interface StoredToolPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'tool';
    callID: string;
    tool: string;
    state: {
        status: 'pending' | 'running' | 'completed' | 'error';
        input: Record<string, unknown>;
        output?: string;
        error?: string;
    };
}
/**
 * Stored reasoning/thinking part
 */
export interface StoredReasoningPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'reasoning';
    text: string;
}
/**
 * Union of all stored part types
 */
export type StoredPart = StoredTextPart | StoredToolPart | StoredReasoningPart | {
    id: string;
    sessionID: string;
    messageID: string;
    type: string;
    [key: string]: unknown;
};
/**
 * Unified recovery configuration
 */
export interface RecoveryConfig {
    /** Whether to enable context window limit recovery */
    contextWindowRecovery?: boolean;
    /** Whether to enable edit error recovery */
    editErrorRecovery?: boolean;
    /** Whether to enable session recovery */
    sessionRecovery?: boolean;
    /** Whether to show detailed recovery messages */
    detailed?: boolean;
    /** Custom recovery messages */
    customMessages?: Partial<Record<RecoveryErrorType & string, string>>;
    /** Whether to enable auto-resume after recovery */
    autoResume?: boolean;
    /** Whether to enable detailed logging */
    debug?: boolean;
}
/**
 * Configuration for retry behavior
 */
export declare const RETRY_CONFIG: {
    /** Maximum retry attempts */
    readonly maxAttempts: 2;
    /** Initial delay between retries in ms */
    readonly initialDelayMs: 2000;
    /** Backoff factor for exponential backoff */
    readonly backoffFactor: 2;
    /** Maximum delay between retries in ms */
    readonly maxDelayMs: 30000;
};
/**
 * Configuration for truncation behavior
 */
export declare const TRUNCATE_CONFIG: {
    /** Maximum truncation attempts */
    readonly maxTruncateAttempts: 20;
    /** Minimum output size (chars) to attempt truncation */
    readonly minOutputSizeToTruncate: 500;
    /** Target token ratio after truncation */
    readonly targetTokenRatio: 0.5;
    /** Average characters per token estimate */
    readonly charsPerToken: 4;
};
//# sourceMappingURL=types.d.ts.map