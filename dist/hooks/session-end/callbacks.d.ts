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
/**
 * Interpolate path placeholders
 */
export declare function interpolatePath(pathTemplate: string, sessionId: string): string;
/**
 * Main callback trigger - called from session-end hook
 *
 * Executes all enabled callbacks in parallel with a timeout.
 * Failures in individual callbacks don't block session end.
 */
export declare function triggerStopCallbacks(metrics: SessionMetrics, _input: {
    session_id: string;
    cwd: string;
}): Promise<void>;
//# sourceMappingURL=callbacks.d.ts.map