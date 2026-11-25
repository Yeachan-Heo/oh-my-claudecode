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
/** Envelope validation for one parsed record; returns an error message or null. */
export declare function envelopeError(value: unknown): string | null;
/**
 * Parses the text of a journal file into its records, with the checks `readAll` makes: every line complete and valid
 * JSON with a well-formed envelope, and seq 0, 1, 2, ... without a gap. Throws JournalCorruptionError counting every bad
 * line, and an incomplete last line as one more. Text that is empty gives no records. `filePath` is named in the error.
 */
export declare function parseJournalText(content: string, filePath: string): readonly JournalRecord[];
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