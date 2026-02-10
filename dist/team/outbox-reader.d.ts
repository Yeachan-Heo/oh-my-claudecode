import type { OutboxMessage } from './types.js';
/** Outbox cursor stored alongside outbox files */
export interface OutboxCursor {
    bytesRead: number;
}
/**
 * Read new outbox messages for a worker using byte-offset cursor.
 * Mirror of readNewInboxMessages() but for the outbox direction.
 */
export declare function readNewOutboxMessages(teamName: string, workerName: string): OutboxMessage[];
/**
 * Read new outbox messages from ALL workers in a team.
 */
export declare function readAllTeamOutboxMessages(teamName: string): {
    workerName: string;
    messages: OutboxMessage[];
}[];
/**
 * Reset outbox cursor for a worker.
 */
export declare function resetOutboxCursor(teamName: string, workerName: string): void;
//# sourceMappingURL=outbox-reader.d.ts.map