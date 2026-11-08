/**
 * Append-only OCC journal over `<runsRoot>/<run_id>/journal.jsonl`.
 *
 * The journal persists committed records with an envelope fingerprint that
 * includes seq/epoch/descriptor_hash/transition. It validates envelope shape
 * and the fingerprint format on read (fail-closed). Deep transition
 * validation happens at the scheduler replay fold; epoch ownership fencing is
 * a runner-level concern (OwnershipFence).
 */
import type { RunDirHandle } from "./run-dir.js";
import type { Journal, JournalAppendRecord, JournalRecord } from "./types.js";
/**
 * Authenticates the runtime envelope binding, including the writer epoch.
 * Scheduler request fingerprints intentionally remain Graph Core concerns;
 * this digest binds the runtime-only epoch to the exact committed record.
 */
export declare function computeJournalFingerprint(record: JournalAppendRecord): string;
export declare class FileJournal implements Journal {
    private readonly runsRoot;
    private readonly runId?;
    private readonly handle?;
    private readonly assertOwnership?;
    /**
     * The frozen `Journal` interface is run-scoped but carries no run id, so an
     * instance must be bound to one run. `runId` is optional only to keep the
     * brief's `new FileJournal(runsRoot)` signature constructible; unbound
     * instances fail closed on use.  An optional ownership callback binds each
     * append to the writer's lease epoch.
     */
    constructor(runsRoot: string, runId?: string, runDirHandle?: RunDirHandle, assertOwnership?: () => void);
    append(record: JournalAppendRecord): Promise<void>;
    private appendInternal;
    private runDir;
    readAll(): Promise<readonly JournalRecord[]>;
}
//# sourceMappingURL=journal.d.ts.map