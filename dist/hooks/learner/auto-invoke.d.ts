export interface InvocationConfig {
    enabled: boolean;
    confidenceThreshold: number;
    maxAutoInvokes: number;
    cooldownMs: number;
}
export interface InvocationRecord {
    skillId: string;
    skillName: string;
    timestamp: number;
    confidence: number;
    prompt: string;
    wasSuccessful: boolean | null;
    feedbackScore: number | null;
}
export interface AutoInvokeState {
    sessionId: string;
    config: InvocationConfig;
    invocations: InvocationRecord[];
    lastInvokeTime: number;
}
/**
 * Load auto-invocation config from ~/.claude/.omc-config.json
 */
export declare function loadInvocationConfig(): InvocationConfig;
/**
 * Initialize auto-invoke state for a session
 */
export declare function initAutoInvoke(sessionId: string): AutoInvokeState;
/**
 * Decide whether to auto-invoke a skill based on confidence and constraints
 */
export declare function shouldAutoInvoke(state: AutoInvokeState, skillId: string, confidence: number): boolean;
/**
 * Record a skill invocation
 */
export declare function recordInvocation(state: AutoInvokeState, record: Omit<InvocationRecord, 'timestamp'>): void;
/**
 * Update the success status of a skill invocation
 */
export declare function updateInvocationSuccess(state: AutoInvokeState, skillId: string, wasSuccessful: boolean): void;
/**
 * Format skill for auto-invocation (more prominent than passive injection)
 */
export declare function formatAutoInvoke(skill: {
    name: string;
    content: string;
    confidence: number;
}): string;
/**
 * Get invocation statistics for the session
 */
export declare function getInvocationStats(state: AutoInvokeState): {
    total: number;
    successful: number;
    failed: number;
    unknown: number;
    averageConfidence: number;
};
/**
 * Save invocation history to disk for analytics
 */
export declare function saveInvocationHistory(state: AutoInvokeState): void;
/**
 * Load invocation history from disk
 */
export declare function loadInvocationHistory(sessionId: string): AutoInvokeState | null;
/**
 * Get aggregated invocation analytics across all sessions
 */
export declare function getAggregatedStats(): {
    totalSessions: number;
    totalInvocations: number;
    successRate: number;
    topSkills: Array<{
        skillId: string;
        skillName: string;
        count: number;
        successRate: number;
    }>;
};
//# sourceMappingURL=auto-invoke.d.ts.map