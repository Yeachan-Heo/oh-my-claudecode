import type { InboxMessage, OutboxMessage, ShutdownSignal, DrainSignal } from './types.js';
/**
 * Append a message to the outbox JSONL file.
 * Creates directories if needed.
 */
export declare function appendOutbox(teamName: string, workerName: string, message: OutboxMessage): void;
/**
 * Rotate outbox if it exceeds maxLines.
 * Keeps the most recent maxLines/2 entries, discards older.
 * Prevents unbounded growth.
 *
 * NOTE: Rotation events are not audit-logged here to avoid circular dependency
 * on audit-log.ts. The caller (e.g., mcp-team-bridge.ts) should log rotation
 * events using the 'outbox_rotated' audit event type after calling this function.
 */
export declare function rotateOutboxIfNeeded(teamName: string, workerName: string, maxLines: number): void;
/**
 * Rotate inbox if it exceeds maxSizeBytes.
 * Keeps the most recent half of lines, discards older.
 * Prevents unbounded growth of inbox files.
 *
 * NOTE: Rotation events are not audit-logged here to avoid circular dependency
 * on audit-log.ts. The caller (e.g., mcp-team-bridge.ts) should log rotation
 * events using the 'inbox_rotated' audit event type after calling this function.
 */
export declare function rotateInboxIfNeeded(teamName: string, workerName: string, maxSizeBytes: number): void;
/**
 * Read new inbox messages using offset cursor.
 *
 * Uses byte-offset cursor to avoid clock skew issues:
 * 1. Read cursor from {worker}.offset file (default: 0)
 * 2. Open inbox JSONL, seek to offset
 * 3. Read from offset to EOF
 * 4. Parse new JSONL lines
 * 5. Update cursor to new file position
 *
 * Handles file truncation (cursor > file size) by resetting cursor.
 */
export declare function readNewInboxMessages(teamName: string, workerName: string): InboxMessage[];
/** Read ALL inbox messages (for initial load or debugging) */
export declare function readAllInboxMessages(teamName: string, workerName: string): InboxMessage[];
/** Clear inbox (truncate file + reset cursor) */
export declare function clearInbox(teamName: string, workerName: string): void;
/** Write a shutdown signal file */
export declare function writeShutdownSignal(teamName: string, workerName: string, requestId: string, reason: string): void;
/** Check if shutdown signal exists, return parsed content or null */
export declare function checkShutdownSignal(teamName: string, workerName: string): ShutdownSignal | null;
/** Delete the shutdown signal file after processing */
export declare function deleteShutdownSignal(teamName: string, workerName: string): void;
/** Write a drain signal for a worker */
export declare function writeDrainSignal(teamName: string, workerName: string, requestId: string, reason: string): void;
/** Check if a drain signal exists for a worker */
export declare function checkDrainSignal(teamName: string, workerName: string): DrainSignal | null;
/** Delete a drain signal file */
export declare function deleteDrainSignal(teamName: string, workerName: string): void;
/** Remove all inbox/outbox/signal files for a worker */
export declare function cleanupWorkerFiles(teamName: string, workerName: string): void;
//# sourceMappingURL=inbox-outbox.d.ts.map