/**
 * Preemptive Compaction Types
 *
 * Type definitions for monitoring context usage and triggering compaction.
 *
 * Adapted from oh-my-opencode's preemptive-compaction hook.
 */
/**
 * State for preemptive compaction tracking
 */
export interface PreemptiveCompactionState {
    /** Map of session ID to last compaction timestamp */
    lastCompactionTime: Map<string, number>;
    /** Set of sessions currently undergoing compaction */
    compactionInProgress: Set<string>;
    /** Map of session ID to warning count */
    warningCount: Map<string, number>;
}
/**
 * Token usage information
 */
export interface TokenInfo {
    /** Input tokens used */
    input: number;
    /** Output tokens generated */
    output: number;
    /** Reasoning tokens (for thinking models) */
    reasoning: number;
    /** Cache statistics */
    cache: {
        read: number;
        write: number;
    };
}
/**
 * Model context limits
 */
export interface ModelLimits {
    /** Maximum context tokens */
    context: number;
    /** Maximum output tokens */
    output: number;
}
/**
 * Context usage analysis result
 */
export interface ContextUsageResult {
    /** Estimated total tokens used */
    totalTokens: number;
    /** Estimated usage ratio (0-1) */
    usageRatio: number;
    /** Whether usage is above warning threshold */
    isWarning: boolean;
    /** Whether usage is above critical threshold */
    isCritical: boolean;
    /** Suggested action */
    action: 'none' | 'warn' | 'compact';
}
/**
 * Configuration for preemptive compaction
 */
export interface PreemptiveCompactionConfig {
    /** Enable preemptive compaction warnings */
    enabled?: boolean;
    /** Threshold ratio (0-1) to trigger warning (default: 0.85) */
    warningThreshold?: number;
    /** Threshold ratio (0-1) to trigger critical warning (default: 0.95) */
    criticalThreshold?: number;
    /** Cooldown period in ms between warnings (default: 60000) */
    cooldownMs?: number;
    /** Maximum warnings before stopping (default: 3) */
    maxWarnings?: number;
    /** Custom warning message */
    customMessage?: string;
}
//# sourceMappingURL=types.d.ts.map