/**
 * Factory chain audit view (D2): a read-only summary of what the chain did in
 * this project. Everything here reads the same durable artifacts the runtime
 * writes — the decisions trail, stop markers, link ledgers, the authoritative
 * route table — so the view can never disagree with the state the chain left
 * behind. Pure reads; no locking, no writes.
 */
import { type StalledLink } from './watchdog.js';
export interface ChainIntentSummary {
    intentId: string;
    decisionCount: number;
    /** decision name -> occurrences, e.g. { enqueued: 3, 'chain-terminal': 1 }. */
    counts: Record<string, number>;
    lastDecision?: string;
    /** ISO 8601, from the decision record. */
    lastDecisionAt?: string;
    stopped?: {
        reason: string;
        stoppedAt: string;
    };
}
export interface ChainStatus {
    directory: string;
    /** Keys of the project route table (the single authority, upstream #4176). */
    routeKeys: string[];
    /** Link ledgers still on disk (pre-written first rings and enqueued links alike). */
    activeLedgers: number;
    /** Most-recently-active first. */
    intents: ChainIntentSummary[];
    stalled: StalledLink[];
}
export declare function readChainStatus(directory: string, now?: Date): ChainStatus;
//# sourceMappingURL=status.d.ts.map