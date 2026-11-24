/**
 * Graph Runtime v2 internal contracts.
 *
 * Lead-authored and frozen for the graph-runtime-v2 team. Runtime modules
 * implement these without redefining any Graph Core semantics: the sealed
 * descriptor and pure scheduler contracts in `src/graph/*` remain
 * authoritative and are consumed verbatim (ADR 03570 boundary).
 */
/** Closed error surface for fence failures surfaced to the runner. */
export class FenceError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "FenceError";
        this.code = code;
    }
}
/** Journal is corrupt or has an incomplete trailing line (fail-closed). */
export class JournalCorruptionError extends Error {
    /** Number of trailing incomplete/unparseable records dropped by readAll. */
    truncatedCount;
    constructor(message, truncatedCount) {
        if (!Number.isInteger(truncatedCount) || truncatedCount < 1) {
            throw new Error("truncatedCount must be a positive integer");
        }
        super(message);
        this.name = "JournalCorruptionError";
        this.truncatedCount = truncatedCount;
    }
}
/**
 * Normative process exit codes for `omc graph run`. The CLI maps runner
 * outcomes to these; e2e tests assert on them.
 */
export const EXIT_CODES = {
    OK: 0,
    FAILED_TERMINAL: 1,
    FENCED_OUT: 19,
    CORRUPT_JOURNAL: 20,
    DESCRIPTOR_MISMATCH: 21,
};
//# sourceMappingURL=types.js.map