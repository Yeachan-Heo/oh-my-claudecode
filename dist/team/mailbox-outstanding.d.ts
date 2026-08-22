export interface OutstandingMailboxCount {
    /** Messages directed TO the worker that are not yet delivered (queued/unanswered work). */
    undeliveredInbound: number;
    /** Messages FROM the worker that are not yet delivered (owed reports/acks). */
    undeliveredOutbound: number;
}
export declare const ZERO_OUTSTANDING: OutstandingMailboxCount;
/**
 * Scan the team mailbox directory and compute undelivered directed-work
 * counts for every worker, reading each `{recipient}.json` / `{recipient}.jsonl`
 * mailbox at most once.
 *
 * Missing directories and malformed files are tolerated (counted as zero)
 * so a transient mailbox write never crashes an idle notification.
 */
export declare function scanMailboxOutstanding(mailboxDir: string): Promise<Record<string, OutstandingMailboxCount>>;
/** Outstanding directed-work counts for a single worker (0/0 when absent or unreadable). */
export declare function countOutstandingForWorker(mailboxDir: string, workerName: string): Promise<OutstandingMailboxCount>;
//# sourceMappingURL=mailbox-outstanding.d.ts.map