/**
 * Stop Hook Callbacks
 *
 * Provides configurable callback handlers for session end events.
 * Supports file logging, Telegram, and Discord notifications.
 */
import type { SessionMetrics } from './index.js';
/**
 * Format session summary for notifications
 */
export declare function formatSessionSummary(metrics: SessionMetrics, format?: 'markdown' | 'json'): string;
export interface TriggerStopCallbacksOptions {
    skipPlatforms?: Array<'file' | 'telegram' | 'discord'>;
    /** Stable manifest action key for retries of a local callback write. */
    idempotencyKey?: string;
}
export interface SessionEndDeferredAction {
    name: string;
    class: 'required' | 'best-effort';
    payload: Record<string, unknown>;
    budgetMs: number;
    /** Stable durable action identity, when provided by the manifest worker. */
    idempotencyKey?: string;
}
export interface SessionEndActionContext {
    directory: string;
    sessionId: string;
    transcriptPath: string;
    metrics: SessionMetrics;
    input: {
        session_id: string;
        cwd: string;
    };
    deadlineAt: string;
    action: SessionEndDeferredAction;
}
export interface SessionEndActionOutcome {
    status: 'completed' | 'skipped' | 'failed' | 'deadline-exceeded';
    detail?: string;
}
/** Interpolate path placeholders. */
export declare function interpolatePath(pathTemplate: string, sessionId: string, idempotencyKey?: string): string;
/** Backward-compatible callback entry point used by existing callers and tests. */
export declare function triggerStopCallbacks(metrics: SessionMetrics, _input: {
    session_id: string;
    cwd: string;
}, options?: TriggerStopCallbacksOptions): Promise<void>;
/** Executes deferred actions only after the manifest worker has armed them. */
export declare function runSessionEndDeferredAction(action: SessionEndDeferredAction, context: SessionEndActionContext): Promise<SessionEndActionOutcome>;
//# sourceMappingURL=callbacks.d.ts.map