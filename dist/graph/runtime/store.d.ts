/**
 * File-backed projection snapshot store (graph runtime v2).
 *
 * Implements ProjectionStore over `<runsRoot>/<run_id>/projection.json`.
 * The journal is the source of truth; this snapshot only accelerates resume
 * and serves status. Every persist goes through temp+rename
 * (atomicWriteJsonSync); every read fails closed on corruption (AC-3).
 */
import type { RunDirHandle } from "./run-dir.js";
import type { ProjectionSnapshotEnvelope, ProjectionStore } from "./types.js";
/** Closed error surface for projection snapshot failures. */
export declare class ProjectionStoreError extends Error {
    readonly code: "descriptor_mismatch" | "corrupt";
    constructor(code: "descriptor_mismatch" | "corrupt", message: string);
}
/**
 * Validates an untrusted parsed envelope; returns it typed or throws corrupt.
 * Fail-closed: never returns partial data (AC-3).
 */
export declare function parseStoredEnvelope(raw: unknown): ProjectionSnapshotEnvelope;
type SnapshotBinding = Pick<ProjectionSnapshotEnvelope, "descriptor_hash" | "run_id" | "revision_id">;
/**
 * The three fields that bind a snapshot to one descriptor, run and revision. save() compares a new envelope with
 * the stored one on them; `omc graph status` and `omc graph gc` compare a stored envelope with the run's descriptor.
 */
export declare function sameSnapshotBinding(left: SnapshotBinding, right: SnapshotBinding): boolean;
/** Load/save surface over one run's `<run_id>/projection.json`. */
export declare class FileProjectionStore implements ProjectionStore {
    private readonly runsRoot;
    private readonly runId;
    private readonly handle?;
    constructor(runsRoot: string, runId: string, runDirHandle?: RunDirHandle);
    private runDir;
    save(envelope: ProjectionSnapshotEnvelope, assertOwnership?: () => void): Promise<void>;
    load(): Promise<ProjectionSnapshotEnvelope | null>;
}
export {};
//# sourceMappingURL=store.d.ts.map