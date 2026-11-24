/**
 * MCP Dispatch Helpers - Utility functions for dispatch queue operations.
 *
 * Extracted to keep mcp-comm.ts within the 800-line module size limit.
 */
import type { DispatchOutcome } from './mcp-comm.js';
/** Convert an exception to a notification error message. */
export declare function notifyExceptionReason(error: unknown): string;
/** Reported, not thrown: callers enqueue after persisting a message or starting a worker, and a throw would hide that fact. */
export declare function enqueueFailedOutcome(error: unknown): DispatchOutcome;
/** Check if a value is a non-empty trimmed string. */
export declare function isExactText(value: unknown): value is string;
/** Resolve a lock path to its canonical form for consistency across symlinks and relative paths. */
export declare function canonicalNotificationLockIdentity(lockPath: string): string;
//# sourceMappingURL=mcp-dispatch-helpers.d.ts.map